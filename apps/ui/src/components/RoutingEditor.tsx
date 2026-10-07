/**
 * The routing rule editor.
 *
 * **The order is data.** Rules are matched top to bottom, so the list is reorderable and the position
 * of each entry is part of the configuration rather than a presentation choice.
 *
 * Two entries are **anchors**: they expand from elsewhere in the document rather than being written
 * out here. `protect-own-networks` sends the local network, the uplink network and loopback direct;
 * `tunnel-resources` emits one rule per resource tunnel.
 *
 * Anchors are **movable, including below a tunnel rule.** Doing so raises a warning in the plan review
 * naming what will be lost, and it is not prevented. Private address space overlaps heavily — corporate
 * networks routinely occupy large parts of 10/8 and 192.168/16, which is also where the management
 * network lives — so a rule sending 192.168.0.0/16 into a tunnel above the protect anchor takes the
 * operator's own traffic with it. But a locked rule would eventually stand between somebody and a
 * configuration they actually need, and the revert window makes the mistake recoverable rather than
 * fatal.
 */

import type { ReactElement } from 'react';
import {
  describeFinal,
  expectedUplinkInterfaces,
  generateRoutingRules,
  type ProfileDocument,
} from '@wayfarer/schemas';
import { readAt, useDraft } from '../lib/draft.ts';

type Rule = Record<string, unknown>;

const ANCHOR_KINDS = new Set(['protect-own-networks', 'tunnel-resources']);

/** What each kind does, in words rather than in its key. */
const DESCRIBE: Record<string, string> = {
  'protect-own-networks':
    'Anchor — the local network, the uplink network and loopback go direct. Keeps this page reachable.',
  'tunnel-resources': 'Anchor — one rule per resource tunnel, in the order the tunnels are listed.',
  private: 'Private address space (10/8, 172.16/12, 192.168/16 and equivalents).',
  ruleSet: 'Everything in the named rule sets.',
  domain: 'These exact host names.',
  domainSuffix: 'Any name ending with these suffixes.',
  ipCidr: 'These address ranges.',
};

export function RoutingEditor({ document }: { document: Record<string, unknown> }): ReactElement {
  const draft = useDraft();
  const rules = (readAt(document, '/routing/rules') as Rule[] | undefined) ?? [];
  const tunnels = (readAt(document, '/tunnels') as Rule[] | undefined) ?? [];
  const ruleSets = (readAt(document, '/routing/ruleSets') as Rule[] | undefined) ?? [];

  const targets = ['direct', 'block', ...tunnels.map((tunnel) => String(tunnel['id']))];

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
    <>
      <p className="muted small">
        Matched from the top. The first rule that matches decides where the traffic goes.
      </p>

      {tunnelRuleAbove !== -1 ? (
        <div className="panel warn">
          Rule {tunnelRuleAbove + 1} sends traffic into a tunnel <strong>above</strong> the protect
          anchor. If it matches your local or uplink network, management traffic goes into the tunnel
          and this device becomes unreachable. Allowed — the plan review will say so again — but check
          it is what you meant.
        </div>
      ) : null}

      <ol className="rules">
        {rules.map((rule, index) => {
          const kind = String(rule['kind']);
          const isAnchor = ANCHOR_KINDS.has(kind);
          const action = rule['action'] as Record<string, unknown> | undefined;

          return (
            <li key={`${index}-${kind}`} className={isAnchor ? 'anchor' : ''}>
              <div className="row">
                <strong>{kind}</strong>
                {isAnchor ? <span className="badge">anchor</span> : null}
                <span className="spacer" />
                <button type="button" onClick={() => move(index, -1)} disabled={index === 0} title="Move up">
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === rules.length - 1}
                  title="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => draft.set('/routing/rules', rules.filter((_, position) => position !== index))}
                >
                  Remove
                </button>
              </div>

              <p className="muted small">{DESCRIBE[kind] ?? 'A rule this interface has no description for.'}</p>

              {!isAnchor ? (
                <div className="row">
                  <label>sends to</label>
                  <select
                    value={String(action?.['outbound'] ?? 'direct')}
                    onChange={(event) =>
                      draft.set(`/routing/rules/${index}/action`, { outbound: event.target.value })
                    }
                  >
                    {targets.map((target) => (
                      <option key={target} value={target}>
                        {target}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {kind === 'domain' ? (
                <ListField
                  label="Exact host names, one per line"
                  pointer={`/routing/rules/${index}/domains`}
                  value={rule['domains'] as string[] | undefined}
                />
              ) : null}
              {kind === 'domainSuffix' ? (
                <ListField
                  label="Suffixes, one per line"
                  pointer={`/routing/rules/${index}/suffixes`}
                  value={rule['suffixes'] as string[] | undefined}
                />
              ) : null}
              {kind === 'ipCidr' ? (
                <ListField
                  label="Address ranges, one per line"
                  pointer={`/routing/rules/${index}/cidrs`}
                  value={rule['cidrs'] as string[] | undefined}
                />
              ) : null}
              {kind === 'ruleSet' ? (
                <ListField
                  label="Rule set tags, one per line"
                  pointer={`/routing/rules/${index}/sets`}
                  value={rule['sets'] as string[] | undefined}
                  hint={
                    ruleSets.length === 0
                      ? 'No rule sets are defined in this profile yet, so any tag here will be refused.'
                      : `Defined here: ${ruleSets.map((set) => String(set['tag'])).join(', ')}`
                  }
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      <RulePreview document={document} />

      <div className="row wrap">
        {(['protect-own-networks', 'tunnel-resources'] as const).map((kind) =>
          rules.some((rule) => rule['kind'] === kind) ? null : (
            <button key={kind} type="button" onClick={() => draft.set('/routing/rules', [...rules, { kind }])}>
              Add the {kind} anchor
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => draft.set('/routing/rules', [...rules, { kind: 'domainSuffix', suffixes: [], action: { outbound: 'direct' } }])}
        >
          Add a suffix rule
        </button>
        <button
          type="button"
          onClick={() => draft.set('/routing/rules', [...rules, { kind: 'domain', domains: [], action: { outbound: 'direct' } }])}
        >
          Add an exact-host rule
        </button>
        <button
          type="button"
          onClick={() => draft.set('/routing/rules', [...rules, { kind: 'ipCidr', cidrs: [], action: { outbound: 'direct' } }])}
        >
          Add an address-range rule
        </button>
        <button
          type="button"
          onClick={() => draft.set('/routing/rules', [...rules, { kind: 'private', action: { outbound: 'direct' } }])}
        >
          Add a private-space rule
        </button>
      </div>
    </>
  );
}

/**
 * What the list above actually produces.
 *
 * Rendered from the **profile document** through the same generator the planner uses, never by reading
 * back a generated configuration file. Those are different things, and the difference is the rule:
 * plan review withholds generated *contents* because a core configuration holds resolved credentials.
 * A routing rule is a domain, a suffix, a subnet and a target — there is nothing secret in one, and
 * the anchor-ordering warning is much harder to trust when nobody can see what the order produces.
 *
 * One generator, shared with the planner, so this cannot drift from what is emitted. A preview that
 * disagrees with reality is worse than none, because somebody would believe it.
 */
function RulePreview({ document }: { document: Record<string, unknown> }): ReactElement {
  const profile = document as unknown as ProfileDocument;

  let generated: ReturnType<typeof generateRoutingRules>;
  let final: string;
  try {
    // The draft is edited live and can be momentarily incomplete — a half-typed rule, an empty list.
    // A preview that throws would take the whole editor down with it, so it degrades to a note.
    // The same function the planner's interface list comes from. This page has no inventory, so it
    // cannot filter by what resolved — but it must not compute the names itself, which is how it came
    // to name an uplink that was disabled and would never exist.
    generated = generateRoutingRules(profile, { uplinkInterfaces: expectedUplinkInterfaces(profile) });
    final = describeFinal(profile);
  } catch {
    return (
      <div className="panel">
        <h3>What these rules produce</h3>
        <p className="muted small">Not available while the list is mid-edit.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3>What these rules produce</h3>
      <p className="muted small">
        Matched in this order. Interface names are the ones that will be generated, so they may differ
        from what the device calls them today — and an uplink whose hardware is not present will not
        appear at all once the plan is computed.
      </p>
      <ol className="diff">
        {generated.map((entry, index) => (
          <li key={`${index}-${entry.summary}`}>
            {entry.summary}
            {entry.fromIndex === null ? <span className="muted small"> (added automatically)</span> : null}
          </li>
        ))}
        <li className="muted">{final}</li>
      </ol>
    </div>
  );
}

function ListField({
  label,
  pointer,
  value,
  hint,
}: {
  label: string;
  pointer: string;
  value: string[] | undefined;
  hint?: string;
}): ReactElement {
  const draft = useDraft();
  return (
    <div className="field">
      <label>{label}</label>
      <textarea
        rows={3}
        value={(value ?? []).join('\n')}
        onChange={(event) =>
          draft.set(
            pointer,
            event.target.value
              .split('\n')
              .map((line) => line.trim())
              // An empty line is dropped rather than stored: an empty match term is a rule that matches
              // nothing, silently, and it is the kind of thing a trailing newline creates by accident.
              .filter((line) => line !== ''),
          )
        }
      />
      {hint ? <p className="muted small">{hint}</p> : null}
    </div>
  );
}
