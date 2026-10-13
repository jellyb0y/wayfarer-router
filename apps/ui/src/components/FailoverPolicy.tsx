/**
 * The failover policy: where traffic no rule names goes, and how the device decides a member of a group
 * has stopped working.
 *
 * Since schema 9 the first half is one choice, the egress — a group or a tunnel. There is no order to
 * edit: a group's members are what its subscription offers, and the watchdog keeps its traffic on one
 * healthy member and moves it to the best other one when that member fails.
 *
 * ## Why this is on Tunnels and not on a screen of its own
 *
 * Eleven positions — three about the order and eight thresholds — were reachable from the API and
 * from nothing else, which is precisely the asymmetry Epic E exists to remove. The tempting fix was a
 * screen called *Failover*, and it would have been an eighth screen answering half of a question
 * Tunnels already asks: *what breaks if one dies?* A person reading that list is the person deciding
 * which of them is preferred and how hard a tunnel has to fail before it is dropped, and a screen
 * that shows the first and sends them elsewhere for the second is how the second came to live
 * somewhere nobody opened.
 *
 * So it is folds on the card that already carries what happens when tunnels fail, beside the two
 * device-wide fields `LeakPolicy` edits.
 *
 * ## The thresholds are the owner's, and the defaults are not answers
 *
 * Latency, jitter and loss are measured quantities; a *threshold* is the line somebody draws across
 * one, which is why the schema marks all eight as a person's. Each is a plain number field with the
 * schema's own bounds, and the one sentence beside it says what happens at the edges rather than
 * restating the label — a threshold nothing can satisfy is a watchdog that reports everything as
 * broken, and a threshold everything satisfies is a watchdog that reports nothing.
 */
import type { ReactElement } from 'react';
import { readAt } from '../lib/draft.ts';
import { BooleanChoiceField, Fold, NumberField, SelectField, TextList } from './ui/index.tsx';

/**
 * Whether a recovered preference takes the traffic back.
 *
 * A checkbox would be the reflex and it is the wrong shape, for the same reason `pinName` is not one:
 * **both answers have a consequence**, and a cleared box can only explain one of them. Staying put
 * means a flapping preferred tunnel does not move live connections every time it recovers; returning
 * means the order on this card is what the device actually follows.
 */
const STICKY = [
  {
    value: false,
    title: 'Move live connections',
    consequence:
      'When a group moves to another member, open connections are broken and re-made through it.',
  },
  {
    value: true,
    title: 'Stay where it is',
    consequence:
      'A group keeps its member while it is healthy, and open connections are left where they are when it moves.',
  },
] as const;

export function FailoverPolicy({ document }: { document: Record<string, unknown> }): ReactElement {
  const policy = (readAt(document, '/policy') as Record<string, unknown> | undefined) ?? {};
  const probes = (policy['probes'] as Record<string, unknown> | undefined) ?? {};
  const tunnels = (readAt(document, '/tunnels') as Record<string, unknown>[] | undefined) ?? [];
  const groups = (readAt(document, '/groups') as Record<string, unknown>[] | undefined) ?? [];

  // Groups first: a subscription is what an egress usually is. A tunnel can be one too.
  const choices = [
    ...groups.map((group) => ({ value: String(group['id'] ?? ''), title: `Group · ${String(group['name'] ?? group['id'])}` })),
    ...tunnels.map((tunnel) => ({ value: String(tunnel['id'] ?? ''), title: `Tunnel · ${String(tunnel['name'] ?? tunnel['id'])}` })),
  ].filter((choice) => choice.value !== '');

  return (
    <>
      <Fold summary="Where traffic goes">
        <SelectField
          pointer="/policy/egress"
          label="Egress"
          value={policy['egress']}
          options={choices}
          absent={{ title: 'Nowhere', write: undefined }}
          help="Everything no rule names. A group uses whichever of its members is healthy."
        />
        <BooleanChoiceField
          pointer="/policy/sticky"
          label="On recovery"
          value={policy['sticky'] !== false}
          options={STICKY}
        />
      </Fold>

      {/*
        * How a tunnel is decided to have failed. Folded because it is the rarer visit, and in the
        * same fold as everything else on every screen — never a second mechanism for "advanced".
        */}
      <Fold summary="How it decides">
        <TextList
          pointer="/policy/probes/endpoints"
          label="What it fetches"
          value={probes['endpoints'] as string[] | undefined}
          help="One address per line, fetched through this tunnel; one reachable around it measures the wrong path."
        />
        <NumberField
          pointer="/policy/probes/intervalSeconds"
          label="Check every"
          value={probes['intervalSeconds']}
          min={5}
          max={3600}
          help="Seconds; the whole set is fetched each time."
        />
        <NumberField
          pointer="/policy/probes/count"
          label="Tries per check"
          value={probes['count']}
          min={1}
          max={32}
          help="How many probes make up one reading; fewer is cheaper and noisier."
        />
        <NumberField
          pointer="/policy/probes/maxFails"
          label="Failures allowed"
          value={probes['maxFails']}
          min={1}
          max={32}
          help="Out of the tries above; more than this and the check counts as a failure."
        />
        <NumberField
          pointer="/policy/probes/failStreak"
          label="Consecutive failures"
          value={probes['failStreak']}
          min={1}
          max={32}
          help="How many failed checks in a row before the tunnel is dropped; one is a single bad moment."
        />
        <NumberField
          pointer="/policy/probes/maxLatencyMs"
          label="Slowest accepted"
          value={probes['maxLatencyMs']}
          min={1}
          max={60_000}
          help="Milliseconds; above this the tunnel counts as unhealthy even while it answers."
        />
        {/*
          * Jitter and loss are not decoration beside latency, and the sentences say why rather than
          * restating the label: a channel with a low median and a wide spread is worse to use than a
          * steadier one that is slower, and a channel that answers nine times in ten is not fast.
          */}
        <NumberField
          pointer="/policy/probes/maxJitterMs"
          label="Spread allowed"
          value={probes['maxJitterMs']}
          min={1}
          max={60_000}
          help="Milliseconds between the fastest and slowest answer; a wide spread stalls things."
        />
        <NumberField
          pointer="/policy/probes/maxLossPercent"
          label="Loss allowed"
          value={probes['maxLossPercent']}
          min={0}
          max={100}
          help="Per cent; zero reports every tunnel as broken."
        />
      </Fold>
    </>
  );
}
