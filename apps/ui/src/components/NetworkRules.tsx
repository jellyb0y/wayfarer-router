/**
 * The two firewall settings that are about **this network** rather than about a tunnel.
 *
 * They are on Network and not on Tunnels for the reason the rest of this card's contents are: the
 * question they answer is *what may leave the network this device serves*, which is the same question
 * as the address range and the resolvers beside them. `killSwitch` and `ntpBypass` are the other two
 * fields of the same object and they are **not** here — they are on Tunnels, because what they answer
 * is *what happens when a tunnel cannot carry it*. One object, two questions, and the split follows
 * the question rather than the object.
 *
 * Six positions, all of them reachable from the API and from no screen until now.
 *
 * ## `ipv6` has one legal answer, and that is said rather than hidden
 *
 * The schema declares it as the single literal `block`. A control with one option looks like an
 * oversight, so the sentence beside it states what the control is: the answer this device has, and
 * why it is not merely "leave IPv6 unrouted". Hiding the field instead would have been the quieter
 * choice and the wrong one — a person who cannot find where IPv6 is decided assumes nobody decided.
 *
 * ## A blocked endpoint promises less than it looks like it promises
 *
 * Entries with an address or ports become firewall rules. Entries with a **domain** become reject
 * rules in the proxy core's routing, which does nothing for a client that resolved the name somewhere
 * else and is connecting to a literal address. That is the single most misleading thing on this card,
 * so it is in the control that causes it rather than in a paragraph above the list.
 */
import type { ReactElement } from 'react';
import { readAt, useDraft } from '../lib/draft.ts';
import { Fold, NumberList, SelectField, TextField } from './ui/index.tsx';

const PROTOCOLS = [
  { value: 'any', title: 'Both' },
  { value: 'tcp', title: 'TCP' },
  { value: 'udp', title: 'UDP' },
] as const;

const IPV6 = [{ value: 'block', title: 'Rejected at the access point' }] as const;

type Entry = Record<string, unknown>;

export function NetworkRules({ document }: { document: Record<string, unknown> }): ReactElement {
  const draft = useDraft();
  const firewall = (readAt(document, '/firewall') as Record<string, unknown> | undefined) ?? {};
  const blocked = (firewall['blockedEndpoints'] as Entry[] | undefined) ?? [];

  return (
    <>
      <SelectField
        pointer="/firewall/ipv6"
        label="IPv6"
        value={String(firewall['ipv6'] ?? 'block')}
        options={IPV6}
        help="The only answer here: unrouted IPv6 would leak every client’s real address while pages still load."
      />

      <Fold summary="Blocked endpoints" count={blocked.length}>
        {blocked.length === 0 ? (
          <p className="muted">
            Nothing is blocked by address. Address-discovery servers answer with the address a packet
            arrived from, so one reached outside a tunnel reports the real one.
          </p>
        ) : null}

        {/* The list is the control for `/firewall/blockedEndpoints`: adding and removing write it whole. */}
        <ol className="tunnel-list" data-pointer="/firewall/blockedEndpoints">
          {blocked.map((entry, index) => (
            <li key={index} className="tunnel-item">
              <div className="row-head">
                <span className="row-title">
                  {String(entry['note'] ?? entry['domain'] ?? entry['ipCidr'] ?? 'Entry')}
                </span>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  onClick={() =>
                    draft.set('/firewall/blockedEndpoints', blocked.filter((_unused, other) => other !== index))
                  }
                >
                  Remove
                </button>
              </div>
              <Fold summary="Edit">
                <TextField
                  pointer={`/firewall/blockedEndpoints/${index}/ipCidr`}
                  label="Address"
                  value={entry['ipCidr']}
                  placeholder="192.0.2.0/24"
                  help="An address or a range — the half a firewall can actually enforce."
                />
                <TextField
                  pointer={`/firewall/blockedEndpoints/${index}/domain`}
                  label="Name"
                  value={entry['domain']}
                  help="Blocked in the routing, not the firewall, so a client using a literal address goes past it."
                />
                {/*
                  * Numbers, not text. A textarea's value is always a string, and this position is a
                  * list of integers: `NumberList` exists so the reuse cannot quietly write `["443"]`
                  * into it, which looks right on screen and is refused on save.
                  */}
                <NumberList
                  pointer={`/firewall/blockedEndpoints/${index}/ports`}
                  label="Ports"
                  value={entry['ports'] as number[] | undefined}
                  help="One per line; left empty, every port is blocked."
                />
                <SelectField
                  pointer={`/firewall/blockedEndpoints/${index}/protocol`}
                  label="Protocol"
                  value={String(entry['protocol'] ?? 'any')}
                  options={PROTOCOLS}
                />
                <TextField
                  pointer={`/firewall/blockedEndpoints/${index}/note`}
                  label="Note"
                  value={entry['note']}
                  help="For whoever reads this list a year from now, including you."
                />
              </Fold>
            </li>
          ))}
        </ol>

        <div className="row-actions">
          <button
            type="button"
            onClick={() => draft.set('/firewall/blockedEndpoints', [...blocked, { protocol: 'any' }])}
          >
            Block an endpoint
          </button>
        </div>
      </Fold>
    </>
  );
}
