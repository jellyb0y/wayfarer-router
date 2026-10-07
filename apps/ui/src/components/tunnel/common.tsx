/**
 * The fields every tunnel has, whatever the catalogue entry — including the two that have never had
 * a control at all.
 *
 * ## `resources`: the half of the product that was invisible
 *
 * A tunnel's domain suffixes and address ranges are **what the tunnel is for**. They are at
 * `/tunnels/N/resources/domainSuffix` and `/ipCidr`; a routing rule's are at
 * `/routing/rules/N/suffixes` and `/cidrs`. Same words on screen, different field underneath — and
 * that collision is exactly how this half stayed invisible long enough for the product to become
 * configurable only through the API. Every label here says what the *tunnel* reaches, and the
 * pointer on the control is what makes the two countable as two.
 *
 * The address ranges are not a convenience beside the names. A name rule can only match a name the
 * device recovered by sniffing the handshake; a connection to a literal address, or one whose name
 * is encrypted, carries no name to match and falls straight past every suffix in the list. A tunnel
 * with suffixes and no ranges is the one real leak path found in this epic.
 *
 * ## `probe`: and what an empty one means
 *
 * The device-wide probe list fetches something on the public internet, which is the right
 * measurement for a tunnel whose job is egress and the wrong one for a tunnel that reaches only
 * internal resources. Measured on the bench board, 2026-09-21: the corporate tunnel's guard fails an
 * internet probe while the tunnel is healthy, because that peer pushes only private routes — and
 * with `block` as the default, a guard acting on that verdict blocks precisely the traffic the
 * tunnel exists to carry.
 *
 * So an empty probe is a real state and the control **says so in words**. Measured the same day: a
 * tunnel with no probe had a guard that could never fire, while a fallback judgement reported it
 * healthy the whole time. A blank where a measurement belongs reads as health, which is the reading
 * this control refuses to produce.
 */
import type { ReactElement } from 'react';
import { readAt, useDraft } from '../../lib/draft.ts';
import { CheckField, ChoiceField, Field, Fold, TextField, TextList } from '../ui/index.tsx';

export type Tunnel = Record<string, unknown>;

/** The two roles, each stating what choosing it does rather than naming a category. */
const ROLES = [
  {
    value: 'alternative',
    title: 'Anything at all',
    consequence: 'It joins the failover group, which carries whatever no rule sends anywhere else.',
  },
  {
    value: 'resource',
    title: 'Only what it reaches',
    consequence: 'It carries only the names and ranges below, and never general traffic.',
  },
] as const;

/**
 * What happens to this tunnel's traffic when the tunnel cannot carry it.
 *
 * `block` is the default and the default is the argument: traffic was assigned here because it must
 * not go anywhere else, so falling through is the opt-in. The arithmetic is not close — an
 * application that cannot connect is an error somebody sees and retries; a request that leaks onto
 * the open network is the exact outcome the tunnel was paid for, and nobody sees it at all.
 */
const ON_UNAVAILABLE = [
  {
    value: 'block',
    title: 'Stop its traffic',
    consequence: 'Anything assigned here stops until the tunnel works again, and nothing leaves unprotected.',
  },
  {
    value: 'fall-through',
    title: 'Let it through',
    /*
     * True since G31 (2026-09-24): until then no route around the tunnel existed and this sentence was
     * false. The warning is the first half on purpose — this is the one choice that sends traffic outside
     * a tunnel, and the owner must read that before the mechanics.
     */
    consequence:
      'Warning: while this tunnel is down, its traffic and the lookups of its names leave OUTSIDE the VPN. ' +
      'Traffic goes out the ordinary way instead — the way traffic no rule names goes — visible to whoever ' +
      'can see the uplink. It moves out after the tunnel reads dead for two rounds in a row (about a minute ' +
      'or more) and back after it reads alive for three.',
  },
] as const;

export function TunnelCommonFields({ index, tunnel }: { index: number; tunnel: Tunnel }): ReactElement {
  const draft = useDraft();
  const base = `/tunnels/${index}`;
  const role = String(tunnel['role'] ?? 'alternative');
  const dns = tunnel['dns'] as Record<string, unknown> | undefined;

  return (
    <>
      <TextField pointer={`${base}/name`} label="Name" value={tunnel['name']} />

      <ChoiceField pointer={`${base}/role`} label="What it carries" value={role} options={ROLES} />

      <CheckField
        pointer={`${base}/enabled`}
        label="In use"
        checked={tunnel['enabled'] !== false}
        help="Turned off, nothing starts it and no rule reaches it, but the settings are kept."
      />

      <ChoiceField
        pointer={`${base}/onUnavailable`}
        label="If it fails"
        value={String(tunnel['onUnavailable'] ?? 'block')}
        options={ON_UNAVAILABLE}
      />

      {/*
        * Shown for a resource tunnel and for no other, because that is the only kind these mean
        * anything for: `tunnel-resources` expands one routing rule per resource tunnel out of exactly
        * these two lists. Drawn beside an alternative tunnel they would be two boxes that change
        * nothing, which is a worse answer than their absence.
        */}
      {role === 'resource' ? (
        <>
          <TextList
            pointer={`${base}/resources/domainSuffix`}
            label="Reaches these names"
            value={(tunnel['resources'] as Record<string, unknown> | undefined)?.['domainSuffix'] as string[] | undefined}
            help="One suffix per line; a name matches only when the connection reveals it."
          />
          <TextList
            pointer={`${base}/resources/ipCidr`}
            label="Reaches these ranges"
            value={(tunnel['resources'] as Record<string, unknown> | undefined)?.['ipCidr'] as string[] | undefined}
            help="The only thing a connection to a literal address, or to an encrypted name, can match."
          />
        </>
      ) : null}


      {/*
        * Folded rather than absent: a resolver reachable only through the tunnel is an ordinary need
        * on a corporate tunnel and a rare one everywhere else, and this screen is the only place these
        * three fields can live at all.
        */}
      <Fold summary="Resolver">
        <TextField
          pointer={`${base}/dns/server`}
          label="Resolver address"
          value={dns?.['server']}
          help="A resolver reachable only through this tunnel."
        />
        <CheckField
          pointer={`${base}/dns/dynamic`}
          label="Pushed by peer"
          checked={dns?.['dynamic'] === true}
          help="The peer supplies this on each connection; fixing it by hand breaks name resolution."
        />
        <TextList
          pointer={`${base}/dns/domainSuffix`}
          label="Only these names"
          value={dns?.['domainSuffix'] as string[] | undefined}
          help="Leave empty to send every name here while the tunnel is up."
        />
      </Fold>
    </>
  );
}
