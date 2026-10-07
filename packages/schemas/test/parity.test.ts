/**
 * The parity comparison, and what it prints when it is given nothing.
 *
 * The comparison itself — the required set against the manifest — runs in the interface's suite,
 * in the same process that writes the manifest from the rendered DOM, because a manifest read from
 * a second process can be stale and a stale manifest fails in the reassuring direction. These tests
 * are the other half: the comparator is a pure function here, so it can be handed the inputs a real
 * run never produces, which is the only way the emptiness cases are reachable at all.
 *
 * Every case below is a mutation. A check that has never been observed failing, and a check that
 * has never been observed passing, are each worth the same.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Type } from '@sinclair/typebox';

import {
  ALL_SCHEMAS,
  FIELD_SOURCES,
  TUNNEL_CONFIGS,
  describeParity,
  documentPositions,
  isComposite,
  parityReport,
  ProfileDocument,
  parityRequirements,
  secretPointers,
  Source,
  type ParityManifest,
  type ParityRequirement,
} from '../src/index.ts';

const SOME_REQUIREMENT: ParityRequirement[] = [
  { pointer: '/accessPoint/passphrase', layer: 'refusal', because: 'a pre-shared key' },
];

const SOME_MANIFEST: ParityManifest = {
  screens: ['network'],
  fields: [{ pointer: '/accessPoint/passphrase', screen: 'network' }],
};

/* ── it can go green, and it can go red, on the same requirement ─────────────────────────── */

test('a rendered requirement passes, and the same requirement removed from the manifest fails', () => {
  assert.deepEqual(parityReport(SOME_REQUIREMENT, SOME_MANIFEST).faults, []);

  const removed = parityReport(SOME_REQUIREMENT, { screens: ['network'], fields: [] });
  assert.deepEqual(
    removed.faults.map((fault) => fault.kind),
    ['unreachable'],
  );
  assert.match(describeParity(removed), /\/accessPoint\/passphrase/);
});

/* ── what it prints when it is given nothing ─────────────────────────────────────────────── */

test('an absent manifest is a failure naming the file, not a pass', () => {
  const report = parityReport(SOME_REQUIREMENT, null, 'apps/ui/parity-manifest.json');
  assert.deepEqual(
    report.faults.map((fault) => fault.kind),
    ['manifest-absent', 'unreachable'],
  );
  assert.match(describeParity(report), /is not there/);
});

test('a manifest that looked at no screens is a failure, not a pass', () => {
  const report = parityReport(SOME_REQUIREMENT, { screens: [], fields: [] });
  assert.deepEqual(
    report.faults.map((fault) => fault.kind),
    ['manifest-has-no-screens', 'unreachable'],
  );
});

test('an empty required set is a failure, because it would pass against no interface at all', () => {
  const report = parityReport([], SOME_MANIFEST);
  assert.deepEqual(
    report.faults.map((fault) => fault.kind),
    ['nothing-required'],
  );
  assert.match(describeParity(report), /vacuous/);
});

test('both sides empty produces both faults rather than silence', () => {
  const report = parityReport([], { screens: [], fields: [] });
  assert.deepEqual(
    report.faults.map((fault) => fault.kind).sort(),
    ['manifest-has-no-screens', 'nothing-required'],
  );
});

/* ── the two conventions the comparison rests on, asserted rather than assumed ───────────── */

/**
 * A screen that edits nothing is listed, and listing it satisfies nothing.
 *
 * The manifest carries screens with no fields on purpose, so that *nothing to fill here* and *never
 * looked at* are different states. The consequence a future reader might get wrong is this one: a
 * screen's presence says the interface was walked, never that a field on it renders.
 */
test('a listed screen with no fields does not satisfy anything', () => {
  const report = parityReport(SOME_REQUIREMENT, { screens: ['network', 'events'], fields: [] });
  assert.deepEqual(
    report.faults.map((fault) => fault.kind),
    ['unreachable'],
  );
});

/**
 * The manifest normalises numeric segments to `-` so that it describes positions rather than a
 * fixture's rows, and the required set uses the same form. If either side dropped that convention
 * the check would go red in a way nobody could read, so the dependence is asserted.
 */
test('a manifest entry naming a row rather than a position does not match', () => {
  const required: ParityRequirement[] = [
    { pointer: '/uplinks/-/config/psk', layer: 'refusal', because: 'a pre-shared key' },
  ];
  const byRow: ParityManifest = {
    screens: ['network'],
    fields: [{ pointer: '/uplinks/0/config/psk', screen: 'network' }],
  };
  assert.deepEqual(
    parityReport(required, byRow).faults.map((fault) => fault.kind),
    ['unreachable'],
  );
});

/* ── the derivation is not itself empty ──────────────────────────────────────────────────── */

/**
 * `nothing-required` is the fault that fires when the schema walk returns nothing, and it can only
 * fire if something would otherwise have been found. This is the positive half: the real derivation
 * produces positions, every one of them a pointer, and no duplicates — a duplicate would inflate
 * `requiredCount` in the output a reader quotes.
 */
test('the real derivation produces positions rather than an empty list', () => {
  const required = parityRequirements();
  assert.ok(required.length > 0, 'parityRequirements() returned nothing, which makes parity vacuous');
  assert.equal(new Set(required.map((entry) => entry.pointer)).size, required.length);
  for (const entry of required) assert.match(entry.pointer, /^\//);
});

/* ── layer 2: every `Secret()` position, and why it is a tripwire rather than a list ─────── */

/**
 * Layer 2 of the boundary rule is *every `Secret()` position*. Measured against this tree it adds
 * nothing to layer 1 and cannot: the refusal's matchers are `secretPointers(ProfileDocument)`, so
 * the two sets are the same set by construction. Writing it out a second time would be two lists of
 * one set, and the one that drifts is whichever was not updated.
 *
 * What it is instead is a guard on the assumption that makes the collapse true — that every secret
 * this repository declares is reachable as a position **in the profile document**. Parity's whole
 * vocabulary is document pointers, because that is what a screen's controls are addressed by. A
 * `Secret()` declared somewhere that is not part of the document has no address in that vocabulary,
 * so it would not be covered by layer 1, would not be covered by layer 2, and nothing would say so.
 *
 * These two tests are what would say so.
 */

/** Every position in a catalogue entry must arrive in the document under that tunnel's `config`. */
test('layer 2: every catalogue entry secret is reachable as a document position', () => {
  const inDocument = new Set(parityRequirements().map((entry) => entry.pointer));
  const missing: string[] = [];

  for (const [protocol, schema] of Object.entries(TUNNEL_CONFIGS)) {
    const declared = secretPointers(schema as unknown as Record<string, unknown>);
    assert.ok(
      declared.length > 0 || protocol.length > 0,
      'a catalogue entry with no secrets at all is possible; this only guards the ones that have them',
    );
    for (const pointer of declared) {
      if (!inDocument.has(`/tunnels/-/config${pointer}`)) missing.push(`${protocol}: ${pointer}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    'a catalogue entry declares a credential that does not appear as a position in the profile ' +
      'document, so no screen can be asked to offer it and no refusal can name it',
  );
});

/**
 * The other end of the same assumption, and the one that will fire first.
 *
 * The API envelopes carry no `Secret()` today. The day one does — a password in a request body, a
 * token in a response — it is a credential parity cannot express, because it is not a position in
 * any document. The failure is the point: it forces the question *does a person type this, and on
 * which screen* to be answered rather than discovered later by the person trying to type it.
 */
test('layer 2: no API schema declares a secret parity has no address for', () => {
  const stray = ALL_SCHEMAS.flatMap((schema) =>
    secretPointers(schema as unknown as Record<string, unknown>).map(
      (pointer) => `${(schema as { $id?: string }).$id ?? 'anonymous'}${pointer}`,
    ),
  );

  assert.deepEqual(
    stray,
    [],
    "an API schema declares a Secret() outside the profile document. Parity addresses fields by " +
      'document pointer, so this one is covered by no layer. Decide where a person fills it before ' +
      'the field ships, and record the decision — this test is the only thing that asks.',
  );
});


/* ── the walk: the two rules that decide what counts as a position at all ────────────────── */

/**
 * Both tests below are mutations of `documentPositions()`, and both were run red before being
 * written here. The measurements are recorded in the assertions' messages rather than in a comment,
 * so a future failure states what was true when the rule was pinned.
 */

const positionPointers = (): Set<string> => new Set(documentPositions().map((entry) => entry.pointer));

/**
 * A declaration reused by reference produces a position at **every** pointer it sits at.
 *
 * Four declarations in this document are written once and used several times: the hardware binding,
 * the pin name, the interface takeover, and the identifier. A walk that guards on *every node seen
 * anywhere* rather than on the ancestor chain is a memo keyed on object identity, so the second
 * pointer returns before emitting anything: the position is neither required nor exempt, it is
 * absent, and nothing says so. That is the silent pass this whole check exists to prevent, and it
 * was inside the check.
 *
 * The families are asserted whole rather than by naming the positions that happened to vanish,
 * because *which* use is reached first depends on the order of properties in the document. Naming
 * the casualties would make this test agree with a reordering that only moved the hole. A family
 * asserted whole goes red wherever the hole lands: a global set leaves at most one member of each
 * family alive.
 *
 * Measured 2026-09-21 by restoring the global set, **after** the three identifiers were marked
 * `generated`: 129 positions where there are 133, losing `/accessPoint/bind/by`,
 * `/accessPoint/bind/value`, `/accessPoint/pinName` and `/accessPoint/takeOverInterface`.
 *
 * Four, where the same mutation cost eight that morning and the commit that fixed the walk reports
 * ten. The derivation of all three numbers is in `parity.ts`; the part that belongs here is what it
 * did to **this test**. `Source()` copies the schema, so `Identifier` stopped being the same object
 * at four of its five pointers — only `/tunnels/-/config/entryPoints/-/id` still held it raw, and
 * one use cannot collide with itself.
 *
 * Measured again 2026-09-21, after that last pointer was marked `generated` too: **still four, and
 * the same four.** `Identifier` is now shared by reference at no pointer at all, so its family
 * below proves nothing about the rule and the three remaining families carry it alone. The number
 * not moving is the whole finding: a family that catches nothing and a family that catches
 * something are indistinguishable from the total.
 *
 * That is the thing to carry away rather than the number. A mark added for an entirely unrelated
 * reason took a member out of this guard's reach without touching the guard, the test or the walk,
 * and nothing would have said so. **Whenever a wrapper is applied to a declaration, ask what was
 * relying on that declaration being shared by reference.** Asking it by hand is what was missed
 * twice, so the test below now asks it mechanically: which declarations are *still* shared is
 * asserted, not assumed, and a wrapper that dissolves the next one goes red in the diff that
 * applies it rather than in a measurement somebody remembers to retake.
 */
test('a declaration used at several pointers yields a position at each of them', () => {
  const pointers = positionPointers();

  const families: Record<string, string[]> = {
    HardwareBinding: [
      '/accessPoint/bind/by',
      '/accessPoint/bind/value',
      '/uplinks/-/bind/by',
      '/uplinks/-/bind/value',
    ],
    PinName: ['/accessPoint/pinName', '/uplinks/-/pinName'],
    TakeOverInterface: ['/accessPoint/takeOverInterface', '/uplinks/-/takeOverInterface'],
    /*
     * Shared by reference at none of these pointers since 2026-09-21: every use of `Identifier` is
     * now wrapped, and each wrapper is a copy. Kept because the five positions are worth asserting
     * on their own — losing one would be a hole wherever it came from — but it proves nothing about
     * the memo defect, and the assertion below is what now says so out loud.
     */
    Identifier: [
      '/subscriptions/-/id',
      '/tunnels/-/config/entryPoints/-/id',
      '/tunnels/-/derivedFrom/subscription',
      '/tunnels/-/id',
      '/uplinks/-/id',
    ],
  };

  for (const [declaration, uses] of Object.entries(families)) {
    assert.ok(uses.length > 1, `${declaration} is listed here because it is used more than once`);
    assert.deepEqual(
      uses.filter((pointer) => !pointers.has(pointer)),
      [],
      `${declaration} is written once and used at ${uses.length} pointers, and the walk emitted a ` +
        'position at only some of them. A walk that remembers nodes instead of ancestors returns ' +
        'early at the second use and the position vanishes entirely — not required, not exempt.',
    );
  }
});

/**
 * And which declarations are *still* shared by reference, because that is what the guard above is
 * made of and it has now been silently reduced twice.
 *
 * Sharing is a property of the declarations, not of the walk. Every wrapper that spreads — `Source()`,
 * `Secret()`, the next helper somebody writes — returns a copy, so applying one to a declaration used
 * at several pointers dissolves the sharing there and takes that family out of the memo guard's
 * reach. Nothing fails when that happens: the family test above keeps asserting positions that still
 * exist, the walk is unchanged, and the guard simply has less left to catch. Measured 2026-09-21,
 * twice in one day: `Identifier` went from five shared uses to one, and then to none.
 *
 * So the question the notes tell a reader to ask by hand is asked here instead. The expectation is
 * the set of declarations the document still shares, keyed by the pointers they sit at, and it is
 * asserted **whole and exhaustively** rather than as a count — a count would be satisfied by one
 * family dissolving while another appeared, which is precisely the substitution of equal size this
 * file already records being fooled by.
 *
 * Red in either direction is informative and neither direction is a failure of the product:
 *
 * - a family that **disappears** means a wrapper was applied and the memo guard lost it. Retake the
 *   measurement in `parity.ts`, record the new number with its date beside the three already there,
 *   and say in the diff which family stopped being load-bearing;
 * - a family that **appears** means a new declaration is written once and used at several pointers.
 *   Add its pointers to the family test above, since it is now something the memo defect can erase.
 */
test('the declarations still shared by reference are exactly the ones the guard is proved on', () => {
  /*
   * Identity, not equality. Two structurally identical schemas written separately are not shared and
   * cannot collide in a memo; only the same object can.
   *
   * Two things about this descent are load-bearing and were both found by getting them wrong:
   *
   * - **distinct pointers, not occurrences.** A union's branches all sit at their container's
   *   pointer, so `/routing/rules/-/action` is reached five times and `/tunnels/-/config/auth`
   *   twice. Those are one position each and a memo cannot lose them — the walk has already emitted
   *   the pointer. Counting occurrences would list them as shared and the assertion would be about
   *   unions rather than about sharing.
   * - **the array rule, as the walk applies it.** Raw `Identifier` is still the same object at
   *   `/policy/priority/-` and `/policy/excluded/-`, but those are arrays of scalars, which the
   *   walk deliberately never enters, so neither is a position and neither can be erased by a memo.
   *   A descent that entered them would report a shared family the guard cannot be proved on.
   */
  const pointersByObject = new Map<object, Set<string>>();
  const seen = new Set<object>();

  const visit = (node: unknown, pointer: string): void => {
    if (typeof node !== 'object' || node === null) return;
    const at = pointersByObject.get(node) ?? new Set<string>();
    at.add(pointer);
    pointersByObject.set(node, at);
    /* A declaration reached twice is recorded twice and descended once; recursion would not end. */
    if (seen.has(node)) return;
    seen.add(node);

    const record = node as Record<string, unknown>;
    const properties = record['properties'];
    if (typeof properties === 'object' && properties !== null) {
      for (const [key, child] of Object.entries(properties)) visit(child, `${pointer}/${key}`);
    }
    const items = record['items'];
    if (isComposite(items)) visit(items, `${pointer}/-`);
    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = record[keyword];
      if (Array.isArray(branches)) for (const branch of branches) visit(branch, pointer);
    }
  };

  visit(ProfileDocument, '');

  const shared = [...pointersByObject.values()]
    .filter((pointers) => pointers.size > 1)
    .map((pointers) => [...pointers].sort())
    .sort((a, b) => a[0]!.localeCompare(b[0]!));

  assert.deepEqual(
    shared,
    [
      ['/accessPoint/bind', '/uplinks/-/bind'],
      ['/accessPoint/pinName', '/uplinks/-/pinName'],
      ['/accessPoint/takeOverInterface', '/uplinks/-/takeOverInterface'],
    ],
    'the set of declarations shared by reference changed. A family that vanished means a wrapper ' +
      'copied it and the memo guard above lost it — retake the measurement in `parity.ts` and ' +
      'record it with its date. A family that appeared is a declaration the memo defect can now ' +
      'erase, and belongs in the family test above.',
  );
});

/**
 * An array is entered when its items are objects and is itself the position when they are scalars.
 *
 * Both halves are asserted because both halves are wrong in a way that reads as reasonable. Stop at
 * an array of objects and every field of an entry point, a tunnel, an uplink and a routing rule
 * stops being a position: the check goes quiet about eighty-nine positions and reports six new ones
 * named after the containers, which looks like a walk that is working. Descend into an array of
 * scalars and parity demands a control at `/routing/rules/-/suffixes/-` — the third string in a
 * list filled by one control that writes the whole array, an address nothing has and nothing ever
 * will, which is the mirror of a guard no input can reach.
 *
 * The object half asserts `uid` rather than `id`. `/tunnels/-/config/entryPoints/-/id` was one of
 * the positions the visited-set defect above erased, so a branch half dead would have kept this
 * test green on the surviving half. Measured 2026-09-21: making an object array a leaf loses 89
 * positions; descending into scalar arrays replaces 14 list positions with 14 unfillable ones.
 */
test('an array of objects is descended into, and an array of scalars is itself the position', () => {
  const pointers = positionPointers();

  /* Objects: the fields of an entry are the positions, and the array is not one. */
  for (const pointer of [
    '/tunnels/-/config/entryPoints/-/uid',
    '/tunnels/-/config/entryPoints/-/host',
    '/uplinks/-/config/ssid',
    '/routing/rules/-/kind',
    '/subscriptions/-/url',
    '/firewall/blockedEndpoints/-/domain',
  ]) {
    assert.ok(
      pointers.has(pointer),
      `${pointer} is not a position, so the walk stopped at the array above it. Each field of an ` +
        'entry is addressed separately and a control for each is exactly what parity should demand.',
    );
  }

  const containers = ['/uplinks', '/tunnels', '/subscriptions', '/routing/rules', '/routing/ruleSets', '/firewall/blockedEndpoints'];
  assert.deepEqual(
    containers.filter((pointer) => pointers.has(pointer)),
    [],
    'an array of objects is itself a position, which means the walk did not enter it and every ' +
      'field beneath it has silently left the required set',
  );

  /* Scalars: the list is the position, and the element is not. */
  const scalarLists = [
    '/firewall/blockedEndpoints/-/ports',
    '/policy/excluded',
    '/policy/priority',
    '/policy/probes/endpoints',
    '/routing/rules/-/cidrs',
    '/routing/rules/-/domains',
    '/routing/rules/-/sets',
    '/routing/rules/-/suffixes',
    '/tunnels/-/config/alpn',
    '/tunnels/-/dns/domainSuffix',
    '/tunnels/-/resources/domainSuffix',
    '/tunnels/-/resources/ipCidr',
    '/uplinks/-/config/dns',
  ];
  assert.deepEqual(
    scalarLists.filter((pointer) => !pointers.has(pointer)),
    [],
    'a list of scalars must be a position in its own right: one control writes the whole array',
  );
  assert.deepEqual(
    scalarLists.filter((pointer) => pointers.has(`${pointer}/-`)),
    [],
    'the walk descended into a list of scalars, so parity now demands a control for the third ' +
      'string in a list — a requirement nothing can satisfy, because that string has no address ' +
      'of its own and never will',
  );

  /* And the general form of the same rule, so a new scalar list added later is covered too. */
  assert.deepEqual(
    [...pointers].filter((pointer) => pointer.endsWith('/-')),
    [],
    'a position that is a bare array element is a position no control can address',
  );
});


/* ── layer 3: the inheritance rule, proved in both directions ────────────────────────────── */

/**
 * `person` descends from a container; every other source never does.
 *
 * Proved against schemas built for it rather than against the document, and the reason is the rule
 * this project keeps relearning. The document carries no container marked `device`, `subscription`,
 * `catalogue` or `generated` today — every such mark in it is on a leaf, which is exactly what the
 * rule demands — so an assertion made only against it would pass unchanged if inheritance were
 * allowed for all five. It would be a guard no input could reach, asserting the thing it was
 * written to catch was absent because nobody had written it yet.
 *
 * The exempting sources are taken from `FIELD_SOURCES` rather than listed here, so the sixth source
 * somebody adds is covered on the day it is added rather than on the day somebody remembers this
 * test. A hand-written list would have gone quiet about `generated` and said nothing about it.
 *
 * The asymmetry is not stylistic. Inheriting *a person fills this* can only add requirements, so a
 * field added inside such a container is required by default and a mistake appears as a missing
 * control. Inheriting an **exemption** would excuse a field nobody had looked at, which is the
 * silent pass this annotation exists to prevent — and it would do it precisely where it matters
 * most, since containers are where fields get added.
 */
test('a person container descends to its leaves and an exempting container does not', () => {
  const leavesOf = (root: unknown): Record<string, string> =>
    Object.fromEntries(
      documentPositions(root).map((entry) => [
        entry.pointer,
        `${entry.source ?? 'unmarked'}${entry.inherited ? ' (inherited)' : ''}`,
      ]),
    );

  const container = (source: (typeof FIELD_SOURCES)[number]) =>
    Type.Object({
      group: Source(source, Type.Object({ addedLater: Type.String(), own: Source('person', Type.String()) })),
    });

  assert.deepEqual(leavesOf(container('person')), {
    '/group/addedLater': 'person (inherited)',
    '/group/own': 'person',
  });

  const exempting = FIELD_SOURCES.filter((source) => source !== 'person');
  assert.ok(exempting.length > 0, 'every source but `person` is exempting; the set cannot be empty');
  for (const source of exempting) {
    assert.deepEqual(
      leavesOf(container(source)),
      { '/group/addedLater': 'unmarked', '/group/own': 'person' },
      `a container marked ${source} excused a leaf nobody looked at. An exemption must be written ` +
        'on the leaf itself, or forgetting to classify a new field becomes the cheapest way to ' +
        'keep it out of the interface.',
    );
  }
});

/**
 * And the consequence at the layer above: an inherited `person` is required, an exemption on a leaf
 * is not, and an unmarked leaf is required with the layer that says nobody classified it.
 *
 * Asserted on real positions, so the two halves of layer 3 meet: the walk decides the source, and
 * `parityRequirements()` decides what that costs. Each pointer below is named because it is the
 * *only* member of its kind in the tree — the distribution is **136 positions: 122 person, 7
 * generated, 4 device, 2 subscription, 1 catalogue, 0 unmarked** — and a category with one member
 * is a category worth pinning, since deleting its last member would otherwise make this pass by
 * having nothing to test.
 *
 * The distribution is asserted as a whole rather than trusted, and it is asserted **exhaustively**:
 * every position lands in exactly one bucket and the buckets sum to the total. A check on one
 * bucket's size is blind to a swap of equal size — this file already records a count that survived
 * fourteen fillable positions being exchanged for fourteen unfillable ones — so what is pinned is
 * the partition, not a number.
 */
test('an exempting mark removes a position from the required set and an unmarked one does not', () => {
  const all = documentPositions();
  const positions = new Map(all.map((entry) => [entry.pointer, entry]));
  const required = new Map(parityRequirements().map((entry) => [entry.pointer, entry]));

  /* The whole partition, so a mark moved from one bucket to another cannot hide in a total. */
  const distribution: Record<string, number> = {};
  for (const entry of all) distribution[entry.source ?? 'unmarked'] = (distribution[entry.source ?? 'unmarked'] ?? 0) + 1;
  assert.equal(distribution['unmarked'], undefined, 'an unmarked position is a field nobody classified');

  assert.deepEqual(
    distribution,
    /*
     * 119 → 122 on 2026-09-22, when the `Proxy` catalogue entry was added (Epic F, row F5). Exactly
     * three positions are new and all three are `person`: `/tunnels/-/config/type`,
     * `/tunnels/-/config/tlsServerName` and `/tunnels/-/config/tlsCertificate`. The entry's other
     * fields — `server`, `port`, `auth/username`, `auth/password` — are positions the VLESS and
     * OpenVPN branches already contribute at the same pointers, which is why a whole new catalogue
     * entry moves the total by three rather than by seven. Nothing left a bucket.
     *
     * 122 → 121 on 2026-09-24 (plan row G30): `/tunnels/-/probe/endpoints` left the schema. A tunnel's
     * liveness is asked of its protocol, and a person is no longer given a control that points it at
     * something the tunnel carries.
     */
    { person: 121, generated: 7, device: 4, subscription: 2, catalogue: 1 },
    'the source distribution changed. That is not necessarily wrong, but it is never incidental: ' +
      'every entry here is a decision about whether a person must be given a control. Re-derive it ' +
      'and say in the diff which field moved and why.',
  );
  assert.equal(
    Object.values(distribution).reduce((sum, n) => sum + n, 0),
    all.length,
    'the buckets must partition the positions; a leftover means a source nothing accounts for',
  );

  const exempt: Array<[string, string]> = [
    ['/services/clashApi/bind', 'catalogue'],
    ['/subscriptions/-/lastRefresh/ok', 'device'],
    ['/tunnels/-/derivedFrom/subscription', 'subscription'],
    ['/schemaVersion', 'generated'],
  ];
  for (const [pointer, source] of exempt) {
    assert.equal(positions.get(pointer)?.source, source, `${pointer} should be marked ${source}`);
    assert.equal(positions.get(pointer)?.inherited, false, `${pointer} must carry its own mark`);
    assert.equal(required.has(pointer), false, `${pointer} is marked ${source} and is still required`);
  }

  /* An inherited person is required exactly like a written one. */
  assert.equal(positions.get('/tunnels/-/config/flow')?.inherited, true);
  assert.equal(required.get('/tunnels/-/config/flow')?.layer, 'person');

  /**
   * All seven `generated` positions, named, because this is the source that was added rather than
   * discovered and it is the one a later reader will be tempted to reach for. Seven is the whole of
   * it; an eighth arriving without an argument beside it is the exemption list starting to grow,
   * which is what the mark was weighed against rather than what it licenses.
   *
   * The seventh, `/tunnels/-/config/entryPoints/-/id`, was added a commit after the other six and
   * by the identical argument. It had inherited `person` and nobody had asked the question of it,
   * because the task that day was to mark six. **The criterion was applied by going back over what
   * that diff did not look at, not by that diff.**
   */
  assert.deepEqual(
    all.filter((entry) => entry.source === 'generated').map((entry) => entry.pointer),
    [
      '/meta/createdAt',
      '/meta/updatedAt',
      '/schemaVersion',
      '/subscriptions/-/id',
      '/tunnels/-/config/entryPoints/-/id',
      '/tunnels/-/id',
      '/uplinks/-/id',
    ],
    '`generated` means this product is the only possible author of the value. A position added ' +
      'here needs that argument made in the diff, not a resemblance to the six already here.',
  );
  for (const entry of all) {
    if (entry.source !== 'generated') continue;
    assert.equal(entry.inherited, false, `${entry.pointer} must carry its own mark: an exemption never descends`);
    assert.equal(required.has(entry.pointer), false, `${entry.pointer} is marked generated and is still required`);
  }

  /* A secret is required by the refusal whatever its source says, which is layer 1's whole point. */
  assert.equal(positions.get('/subscriptions/-/url')?.source, 'person');
  assert.equal(required.get('/subscriptions/-/url')?.layer, 'refusal');
});

/**
 * The `unmarked` layer, which no position in this document can reach any more.
 *
 * This is the default the whole annotation rests on: a field nobody classified is **required**, so
 * that forgetting the mark is louder than getting it wrong. Until today six positions exercised it.
 * Marking them `generated` was right and emptied the layer, and an empty layer is a branch no input
 * reaches — the shape this repository keeps finding, arriving this time as a consequence of a good
 * decision rather than of a mistake. The branch would now survive its own deletion in silence.
 *
 * So it is proved against a schema built to reach it, which is why `parityRequirements` takes a root
 * at all. Both directions: an unmarked leaf is required and says which layer required it; the same
 * leaf marked is not required. One without the other proves only that the function returns things.
 */
test('an unmarked field is required, and marking it is what removes it', () => {
  const document = (mark: boolean) =>
    Type.Object({
      settings: Type.Object({
        typed: Source('person', Type.String()),
        addedBySomebodyInAHurry: mark ? Source('generated', Type.String()) : Type.String(),
      }),
    });

  const unclassified = parityRequirements(document(false));
  assert.deepEqual(
    unclassified.map((entry) => [entry.pointer, entry.layer]),
    [
      ['/settings/addedBySomebodyInAHurry', 'unmarked'],
      ['/settings/typed', 'person'],
    ],
    'a field that declares no source must be required, and required as `unmarked` rather than ' +
      'quietly folded into `person` — the layer is what tells a reader the field was never ' +
      'classified rather than classified and unreachable.',
  );
  assert.match(
    describeParity(parityReport(unclassified, { screens: ['somewhere'], fields: [] })),
    /addedBySomebodyInAHurry — a field that does not say where its value comes from/,
    'the failure must say what is wrong in words; a pointer alone is a riddle',
  );

  assert.deepEqual(
    parityRequirements(document(true)).map((entry) => entry.pointer),
    ['/settings/typed'],
    'marking the field is the only thing that removes it from the required set, and it removed ' +
      'the wrong one or nothing at all',
  );
});
