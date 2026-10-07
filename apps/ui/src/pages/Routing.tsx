/**
 * Routing answers one question: **what goes where?**
 *
 * ## The order is data
 *
 * Rules match top to bottom and the first match decides, so the position of an entry is part of the
 * configuration rather than a presentation choice. Reordering is therefore an edit, and it is done
 * with two buttons on the row rather than by dragging: a drag target is a control that needs a
 * pointer to discover, and this is a phone.
 *
 * ## Anchors, and why they can be moved into a mistake
 *
 * Two entries are **anchors**: they expand from elsewhere in the document rather than being written
 * out here. `protect-own-networks` sends the local network, the uplink network and loopback direct;
 * `tunnel-resources` emits one rule per resource tunnel, in the order the tunnels are listed.
 *
 * Anchors are **movable, including below a tunnel rule.** Private address space overlaps heavily —
 * corporate networks routinely occupy large parts of 10/8 and 192.168/16, which is also where the
 * management network lives — so a rule sending 192.168.0.0/16 into a tunnel above the protect anchor
 * takes the operator's own traffic with it and this device stops answering. That is warned about
 * here and again in the plan, and it is **not prevented**: a locked rule would eventually stand
 * between somebody and a configuration they actually need, and the revert window makes the mistake
 * recoverable rather than fatal.
 *
 * ## The word that means two different things, and the pointer that tells them apart
 *
 * A rule here carries domain suffixes and address ranges at `/routing/rules/N/suffixes` and
 * `/cidrs`. A **tunnel** carries its own domain suffixes and address ranges at
 * `/tunnels/N/resources/domainSuffix` and `/ipCidr` — what that tunnel exists to reach. Same words
 * on screen, different field underneath, and that is exactly how the tunnel's half stayed invisible
 * long enough to make the product API-only without anybody noticing. This screen says **rule** in
 * every label for that reason, and every control carries its own pointer so the two can never be
 * counted as one.
 */
import type { ReactElement } from 'react';
import { describeFinal, expectedUplinkInterfaces, generateRoutingRules, type ProfileDocument } from '@wayfarer/schemas';
import { useQuery } from '@tanstack/react-query';
import { api, profileApi, type RuleSetAge } from '../lib/api.ts';
import { readAt, useDraft } from '../lib/draft.ts';
import { useProfileEditing } from '../lib/editing.ts';
import { t, tf } from '../lib/i18n.ts';
import {
  Card,
  Field,
  Fold,
  LongValue,
  NumberField,
  Screen,
  SelectField,
  TextField,
  TextList,
} from '../components/ui/index.tsx';
import { PendingBar } from '../components/PendingBar.tsx';
import { protocolTitle } from '../components/tunnel/index.tsx';
import { useProfileTarget } from '../lib/target.ts';

type Rule = Record<string, unknown>;

const ANCHOR_KINDS = new Set(['protect-own-networks', 'tunnel-resources']);

/** What each kind does, in words rather than in its key. */
const DESCRIBE: Record<string, string> = {
  'protect-own-networks': 'The local network, the uplink and loopback go direct. Keeps this page reachable.',
  'tunnel-resources': 'One rule per resource tunnel, in the order the tunnels are listed.',
  private: 'Private address space — 10/8, 172.16/12, 192.168/16 and equivalents.',
  ruleSet: 'Everything in the named rule sets.',
  domain: 'These exact host names.',
  domainSuffix: 'Any name ending with these suffixes.',
  ipCidr: 'These address ranges.',
};

export function Routing(): ReactElement {
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: profileApi.list });
  const target = useProfileTarget();
  const editing = useProfileEditing(target.id);
  const document = editing.draft.draft;

  if (profiles.isLoading) return <Screen title={t('nav.routing')}><p className="muted">{t('common.loading')}</p></Screen>;
  if (target.id === undefined) {
    return (
      <Screen title={t('nav.routing')}>
        <p className="note">{t('routing.noProfile')}</p>
      </Screen>
    );
  }
  if (document === null) return <Screen title={t('nav.routing')}><p className="muted">{t('common.loading')}</p></Screen>;

  return (
    <Screen title={t('nav.routing')}>
      <RuleList document={document} />
      {/*
        * The sets the rules above name, beside the rules that name them. Six positions that nothing
        * had ever rendered — `ruleSets` was unread by any screen — so a `ruleSet` rule could point at
        * a tag that existed only if somebody had written it through the API.
        */}
      <RuleSetList document={document} />
      <Preview document={document} />

      {/*
        * Saving stores a document; applying is a separate act, and a bar that reported only unsaved
        * edits once told a first-time user "No pending changes" while the device ran a configuration
        * the screen was not showing. Both facts, separately — and on a profile that is not running,
        * only the first of them exists.
        */}
      <PendingBar editing={editing} target={target} />

    </Screen>
  );
}

/* ── the ordered list ────────────────────────────────────────────────────────────────────── */

function RuleList({ document }: { document: Record<string, unknown> }): ReactElement {
  const draft = useDraft();
  const rules = (readAt(document, '/routing/rules') as Rule[] | undefined) ?? [];
  const tunnels = (readAt(document, '/tunnels') as Rule[] | undefined) ?? [];

  const move = (index: number, by: number): void => {
    const next = [...rules];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    draft.set('/routing/rules', next);
  };

  const protectIndex = rules.findIndex((rule) => rule['kind'] === 'protect-own-networks');
  const tunnelRuleAbove = rules.findIndex(
    (rule, index) =>
      index < protectIndex &&
      typeof rule['action'] === 'object' &&
      rule['action'] !== null &&
      !['direct', 'block'].includes(String((rule['action'] as Record<string, unknown>)['outbound'])),
  );

  return (
    <Card title={t('routing.rules')}>
      <p className="muted">{t('routing.matchedFromTop')}</p>

      {tunnelRuleAbove !== -1 ? (
        <p className="note">{tf('routing.tunnelAboveAnchor', tunnelRuleAbove + 1)}</p>
      ) : null}

      {/*
        * A list of blocks rather than `RowList`, because a rule carries an editor and a row does
        * not. The editor sits in a `Fold` — the same mechanism as every other advanced setting on
        * every other screen, never a second one — which also means the 360 px bench measures it:
        * the bench opens every fold, and a control that is only reachable through a component's own
        * private open/closed state is a control the bench cannot reach at all.
        */}
      <ol className="rule-list">
        {rules.map((rule, index) => {
          const kind = String(rule['kind']);
          const isAnchor = ANCHOR_KINDS.has(kind);
          return (
            <li key={`${index}-${kind}`} className="rule-item">
              <div className="row-head">
                <span className="row-title">
                  {index + 1} · {kindTitle(kind)}
                </span>
                {isAnchor ? <span className="row-badge pill">{t('routing.anchor')}</span> : null}
              </div>

              <dl className="row-fields">
                <div className="row-field">
                  <dt>{t('routing.does')}</dt>
                  <dd>{DESCRIBE[kind] ?? t('routing.unknownKind')}</dd>
                </div>
                {isAnchor ? null : (
                  <div className="row-field">
                    <dt>{t('routing.sendsTo')}</dt>
                    <dd>{targetTitle(rule, tunnels)}</dd>
                  </div>
                )}
              </dl>

              <div className="row-actions">
                {/* Two buttons rather than a drag handle: a drag target needs a pointer to find. */}
                <button type="button" onClick={() => move(index, -1)} disabled={index === 0}>
                  {t('routing.moveUp')}
                </button>
                <button type="button" onClick={() => move(index, 1)} disabled={index === rules.length - 1}>
                  {t('routing.moveDown')}
                </button>
                <button
                  type="button"
                  onClick={() => draft.set('/routing/rules', rules.filter((_, position) => position !== index))}
                >
                  {t('routing.remove')}
                </button>
              </div>

              {isAnchor ? null : (
                <Fold summary={t('routing.edit')}>
                  <RuleEditor index={index} rule={rule} document={document} />
                </Fold>
              )}
            </li>
          );
        })}
      </ol>

      <Fold summary={t('routing.addRule')}>
        {/*
          * Stamped with `/routing/rules/-/kind`, because this is the control that fills it.
          *
          * A rule's kind is chosen once, when the row is added, and never afterwards: the kinds carry
          * different match fields, so changing one in place would leave a `domainSuffix` rule holding
          * `cidrs`. That makes it a position with no *editor*, not a position with no control — and
          * excluding it in the schema to quieten the check would have recorded convenience where the
          * annotation is supposed to record provenance.
          *
          * `ruleSet` is in the list because the sets it names are now defined on this screen. A kind
          * that can be referenced and not created is the same half-built shape as a set with no
          * editor.
          */}
        <div className="row-actions" data-pointer="/routing/rules/-/kind">
          {(
            [
              ['domainSuffix', { kind: 'domainSuffix', suffixes: [], action: { outbound: 'direct' } }],
              ['domain', { kind: 'domain', domains: [], action: { outbound: 'direct' } }],
              ['ipCidr', { kind: 'ipCidr', cidrs: [], action: { outbound: 'direct' } }],
              ['ruleSet', { kind: 'ruleSet', sets: [], action: { outbound: 'direct' } }],
              ['private', { kind: 'private', action: { outbound: 'direct' } }],
            ] as const
          ).map(([kind, blank]) => (
            <button key={kind} type="button" onClick={() => draft.set('/routing/rules', [...rules, blank])}>
              {kindTitle(kind)}
            </button>
          ))}
          {(['protect-own-networks', 'tunnel-resources'] as const).map((kind) =>
            rules.some((rule) => rule['kind'] === kind) ? null : (
              <button key={kind} type="button" onClick={() => draft.set('/routing/rules', [...rules, { kind }])}>
                {kindTitle(kind)}
              </button>
            ),
          )}
        </div>
      </Fold>
    </Card>
  );
}

/**
 * One rule's own fields.
 *
 * Every control carries the JSON Pointer it writes. That is what makes the coverage manifest a
 * consequence of a rendered screen rather than a list somebody maintains beside it — and it is the
 * only thing that keeps these suffixes distinguishable from a *tunnel's* suffixes, which are the
 * same words at a different pointer.
 */
function RuleEditor({
  index,
  rule,
  document,
}: {
  index: number;
  rule: Rule;
  document: Record<string, unknown>;
}): ReactElement {
  const draft = useDraft();
  const kind = String(rule['kind']);
  const tunnels = (readAt(document, '/tunnels') as Rule[] | undefined) ?? [];
  const ruleSets = (readAt(document, '/routing/ruleSets') as Rule[] | undefined) ?? [];
  const action = rule['action'] as Record<string, unknown> | undefined;

  return (
    <div className="rule-editor">
      <Field pointer={`/routing/rules/${index}/action/outbound`} label={t('routing.sendsTo')}>
        <select
          value={String(action?.['outbound'] ?? 'direct')}
          onChange={(event) => draft.set(`/routing/rules/${index}/action`, { outbound: event.target.value })}
        >
          <option value="direct">{t('routing.direct')}</option>
          <option value="block">{t('routing.block')}</option>
          {/*
            * Tunnels are offered by name and carried by id. The profile's tunnel entry no longer has
            * a `provider`; what it has is `protocol`, one of three, and a typed configuration. The
            * protocol is shown beside the name because two tunnels to the same place over different
            * protocols is an ordinary configuration and the name alone does not separate them.
            */}
          {tunnels.map((tunnel) => (
            <option key={String(tunnel['id'])} value={String(tunnel['id'])}>
              {String(tunnel['name'] ?? tunnel['id'])} · {protocolTitle(tunnel['protocol'])}
            </option>
          ))}
        </select>
      </Field>

      {kind === 'domainSuffix' ? (
        <TextList
          pointer={`/routing/rules/${index}/suffixes`}
          label={t('routing.ruleSuffixes')}
          value={rule['suffixes'] as string[] | undefined}
        />
      ) : null}
      {kind === 'domain' ? (
        <TextList
          pointer={`/routing/rules/${index}/domains`}
          label={t('routing.ruleDomains')}
          value={rule['domains'] as string[] | undefined}
        />
      ) : null}
      {kind === 'ipCidr' ? (
        <TextList
          pointer={`/routing/rules/${index}/cidrs`}
          label={t('routing.ruleCidrs')}
          value={rule['cidrs'] as string[] | undefined}
        />
      ) : null}
      {kind === 'ruleSet' ? (
        <TextList
          pointer={`/routing/rules/${index}/sets`}
          label={t('routing.ruleSets')}
          value={rule['sets'] as string[] | undefined}
          help={
            ruleSets.length === 0
              ? t('routing.noRuleSets')
              : tf('routing.definedHere', ruleSets.map((set) => String(set['tag'])).join(', '))
          }
        />
      ) : null}
    </div>
  );
}

/* ── the rule sets ───────────────────────────────────────────────────────────────────────── */

const SET_TYPES = [
  { value: 'remote', title: 'Fetched' },
  { value: 'local', title: 'A file here' },
] as const;

const SET_FORMATS = [
  { value: 'binary', title: 'Compiled' },
  { value: 'source', title: 'Plain text' },
] as const;

/**
 * The lists a `ruleSet` rule matches against.
 *
 * A rule set is exactly a list of match terms with a name, which is why a rule can point at one
 * instead of holding thousands of suffixes — and why the tag has to be defined somewhere a person
 * can see. Until now it was not: the list was read by the routing generator and by the help sentence
 * on a rule, and written by nothing.
 *
 * **`url` and `path` are drawn by `type`**, and never both. A set is fetched or it is on this device;
 * an entry carrying both is one where the reader cannot tell which one the device used, and the
 * device's answer would be the quiet one.
 */
/**
 * The age of one list, as a pill.
 *
 * Five states, three pills, and the mapping is the argument:
 *
 * * `overdue`, `never-fetched` and `unreadable` are **bad**: for the first two, traffic a rule was
 *   written for is leaving by the ordinary route right now; for the third this device cannot see
 *   the file at all, which is not the same fault and is reported as its own — the sentence beneath
 *   says which, and the drift finding's hint sends somebody to a permission rather than to a URL.
 * * `unmeasurable` and `no-cadence` are **warn**, not bad and never silent. Neither is a fault in
 *   the list — one is a clock that has not been set and the other is a field the profile leaves
 *   empty — but rendering either as fine would put a reassuring colour in front of somebody in
 *   exactly the case where nobody knows.
 * * `fresh` is the only green, and it is green because a number was computed.
 *
 * A set with no answer at all draws nothing: the row is about a set the device may not have been
 * asked about yet, and an empty pill would be a claim.
 */
function RuleSetAgeBadge({ age }: { age: RuleSetAge | null }): ReactElement | null {
  if (age === null) return null;
  if (age.state === 'fresh') {
    /*
     * **The device's own words for its own number.**
     *
     * This drew the figure with a second formatter, and the two had already drifted: one switched to
     * hours at sixty minutes and the other at ninety, so a row read `1h` in the pill and `83m ago` in
     * the sentence under it. One quantity, one formatter, on the side that decided it was honest to
     * compute at all.
     *
     * A remote set's figure is a **lower** bound, so the pill says *at least* rather than printing a
     * duration that reads as a measurement. The sentence beneath carries the rest.
     */
    if (age.ageLabel === null) return null;
    return <span className="row-badge pill ok">{age.exact ? age.ageLabel : `≥ ${age.ageLabel}`}</span>;
  }
  if (age.state === 'overdue') return <span className="row-badge pill bad">{t('routing.setOverdue')}</span>;
  if (age.state === 'never-fetched') return <span className="row-badge pill bad">{t('routing.setNeverFetched')}</span>;
  if (age.state === 'unreadable') return <span className="row-badge pill bad">{t('routing.setUnreadable')}</span>;
  return <span className="row-badge pill warn">{t('routing.setAgeUnknown')}</span>;
}

function RuleSetList({ document }: { document: Record<string, unknown> }): ReactElement {
  const draft = useDraft();
  const target = useProfileTarget();
  const sets = (readAt(document, '/routing/ruleSets') as Rule[] | undefined) ?? [];
  const used = new Set(
    rulesOf(document)
      .filter((rule) => rule['kind'] === 'ruleSet')
      .flatMap((rule) => (rule['sets'] as string[] | undefined) ?? []),
  );

  /*
   * **How old this device's copy of each list actually is.**
   *
   * A failed refresh falls back to the copy on disk rather than refusing, which is the right
   * behaviour and has a bill: a list that is out of date does not know addresses allocated since it
   * was written, so part of the traffic a rule was written for leaves by the ordinary route while
   * the tunnel, the rule and the core all look healthy.
   *
   * The device words the answer and this only prints it. Nothing here subtracts two timestamps: the
   * board has no clock battery, and the decision about when an age can honestly be computed at all
   * is argued once, on the daemon's side, rather than a second time in a browser whose clock is a
   * different clock again.
   *
   * Read from the **stored** profile rather than the draft, so it describes what is running: adding
   * a set to the draft does not make the device hold a copy of it.
   */
  const ages = useQuery({ queryKey: ['rule-set-ages'], queryFn: api.ruleSetAges });
  /*
   * **And only when the profile on this screen is the one the ages are about.**
   *
   * The device answers about the **active** profile, because the ages describe files it actually
   * holds and only an applied profile caused one to be written. This screen can be editing a
   * different profile, chosen in Settings, and the join between the two is a tag string — so an
   * unapplied profile reusing the tag `geoip-ru` would be shown the running profile's freshness for
   * a list this device may never have fetched. A false *this list is fine*, produced by a string
   * match, in the one place somebody is deciding whether to trust a list.
   *
   * So the answer carries the profile it is about and this compares it. On a mismatch the rows say
   * nothing about age rather than something reassuring.
   */
  const answersAboutThis = target.id !== undefined && ages.data?.profileId === target.id;
  const ageByTag = new Map(answersAboutThis ? (ages.data?.sets ?? []).map((set) => [set.tag, set]) : []);

  return (
    <Card title={t('routing.sets')}>
      <p className="muted">{t('routing.setsAre')}</p>

      {/* The list is the control for `/routing/ruleSets`: adding and removing write that position whole. */}
      <ol className="rule-list" data-pointer="/routing/ruleSets">
        {sets.map((set, index) => {
          const tag = String(set['tag'] ?? '');
          const type = String(set['type'] ?? 'remote');
          return (
            <li key={`${index}-${tag}`} className="rule-item">
              <div className="row-head">
                <span className="row-title">{tag === '' ? t('routing.setUnnamed') : tag}</span>
                {/*
                  * Said on the row, because a set nothing points at is loaded, fetched and refreshed
                  * for nobody — and it is the state that looks identical to a working one.
                  */}
                {used.has(tag) ? null : <span className="row-badge pill warn">{t('routing.setUnused')}</span>}
                <RuleSetAgeBadge age={used.has(tag) ? (ageByTag.get(tag) ?? null) : null} />
              </div>

              {/*
                * The sentence under the badge, in the device's own words.
                *
                * A badge alone would be a colour somebody learns to stop seeing; the sentence says
                * which list, how old and — when there is no number — which of the three reasons
                * there is not one. A blank here would read as health, which is the reading this row
                * exists to refuse.
                */}
              {used.has(tag) && ageByTag.has(tag) ? (
                <p className="muted">{ageByTag.get(tag)!.summary}</p>
              ) : null}

              <div className="row-actions">
                <button
                  type="button"
                  onClick={() => draft.set('/routing/ruleSets', sets.filter((_, other) => other !== index))}
                >
                  {t('routing.remove')}
                </button>
              </div>

              <Fold summary={t('routing.edit')}>
                <TextField
                  pointer={`/routing/ruleSets/${index}/tag`}
                  label={t('routing.setTag')}
                  value={set['tag']}
                  help={t('routing.setTagHelp')}
                />
                <SelectField
                  pointer={`/routing/ruleSets/${index}/type`}
                  label={t('routing.setType')}
                  value={type}
                  options={SET_TYPES}
                />
                {type === 'remote' ? (
                  <>
                    <TextField
                      pointer={`/routing/ruleSets/${index}/url`}
                      label={t('routing.setUrl')}
                      value={set['url']}
                      help={t('routing.setUrlHelp')}
                    />
                    <NumberField
                      pointer={`/routing/ruleSets/${index}/updateIntervalHours`}
                      label={t('routing.setInterval')}
                      value={set['updateIntervalHours']}
                      min={1}
                      max={720}
                      help={t('routing.setIntervalHelp')}
                    />
                  </>
                ) : (
                  <TextField
                    pointer={`/routing/ruleSets/${index}/path`}
                    label={t('routing.setPath')}
                    value={set['path']}
                    help={t('routing.setPathHelp')}
                  />
                )}
                {/*
                  * Optional in the schema, and absence means something: with no format the core reads
                  * the file by its extension. An empty `<option>` would write `""`, which is in
                  * neither half of the union and is refused on save — so the control writes absence.
                  */}
                <SelectField
                  pointer={`/routing/ruleSets/${index}/format`}
                  label={t('routing.setFormat')}
                  value={set['format']}
                  options={SET_FORMATS}
                  absent={{ title: t('routing.setFormatAbsent'), write: undefined }}
                />
              </Fold>
            </li>
          );
        })}
      </ol>

      <div className="row-actions">
        <button
          type="button"
          onClick={() => draft.set('/routing/ruleSets', [...sets, { tag: '', type: 'remote' }])}
        >
          {t('routing.addSet')}
        </button>
      </div>
    </Card>
  );
}

function rulesOf(document: Record<string, unknown>): Rule[] {
  return (readAt(document, '/routing/rules') as Rule[] | undefined) ?? [];
}

/* ── the preview ─────────────────────────────────────────────────────────────────────────── */

/**
 * What the list above actually produces.
 *
 * Rendered from the **profile document** through the same generator the planner uses, never by
 * reading back a generated configuration file. One generator, so the preview cannot drift from what
 * is emitted — and a preview that disagreed with reality would be worse than none, because somebody
 * would believe it.
 *
 * There is nothing secret in a routing rule — a domain, a suffix, a subnet and a target — which is
 * why this shows contents while the plan review withholds generated files, whose contents hold
 * resolved credentials.
 */
function Preview({ document }: { document: Record<string, unknown> }): ReactElement {
  const profile = document as unknown as ProfileDocument;

  let generated: ReturnType<typeof generateRoutingRules>;
  let final: string;
  try {
    // The draft is edited live and can be momentarily incomplete — a half-typed rule, an empty list.
    // A preview that threw would take the screen down with it, so it degrades to a note.
    generated = generateRoutingRules(profile, { uplinkInterfaces: expectedUplinkInterfaces(profile) });
    final = describeFinal(profile);
  } catch {
    return (
      <Card title={t('routing.produces')}>
        <p className="muted">{t('routing.previewUnavailable')}</p>
      </Card>
    );
  }

  return (
    <Card title={t('routing.produces')}>
      <p className="muted">{t('routing.previewIs')}</p>
      <ol className="preview">
        {/*
          * A generated rule reads back the names and ranges it matches, so a rule holding a
          * 253-character domain is a 296-character sentence — nine line boxes in a 282 px column,
          * measured at 360 px. Cut after three, with the whole of it in the copy control: rule 6,
          * on a value that happens to arrive inside a sentence.
          */}
        {generated.map((entry, index) => (
          <li key={`${index}-${entry.summary}`}>
            <LongValue value={entry.summary} lines={3} mono={false} label={t('routing.produces')} />
            {entry.fromIndex === null ? <span className="muted"> · {t('routing.addedAutomatically')}</span> : null}
          </li>
        ))}
        <li className="muted">
          <LongValue value={final} lines={3} mono={false} label={t('routing.produces')} />
        </li>
      </ol>
    </Card>
  );
}

/* ── words ───────────────────────────────────────────────────────────────────────────────── */

function kindTitle(kind: string): string {
  switch (kind) {
    case 'protect-own-networks':
      return t('routing.kindProtect');
    case 'tunnel-resources':
      return t('routing.kindResources');
    case 'private':
      return t('routing.kindPrivate');
    case 'ruleSet':
      return t('routing.kindRuleSet');
    case 'domain':
      return t('routing.kindDomain');
    case 'domainSuffix':
      return t('routing.kindSuffix');
    case 'ipCidr':
      return t('routing.kindCidr');
    default:
      return kind;
  }
}

/*
 * `protocolTitle` used to be written out here as a `switch` over three literals, beside a comment
 * saying it must be read from the catalogue. It is imported from `components/tunnel` now, and
 * re-exported so the assertion that pins it keeps one target. See there for why a second list is
 * the defect and not merely a duplication.
 */
export { protocolTitle };

function targetTitle(rule: Rule, tunnels: Rule[]): string {
  const action = rule['action'] as Record<string, unknown> | undefined;
  const outbound = String(action?.['outbound'] ?? 'direct');
  if (outbound === 'direct') return t('routing.direct');
  if (outbound === 'block') return t('routing.block');
  const tunnel = tunnels.find((entry) => String(entry['id']) === outbound);
  return tunnel ? `${String(tunnel['name'] ?? outbound)} · ${protocolTitle(tunnel['protocol'])}` : outbound;
}
