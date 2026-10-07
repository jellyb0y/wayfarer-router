/**
 * Network answers one question: **the access point, and the uplink it is using.**
 *
 * It also carries the one thing no other screen can show, and the reason it is here rather than in
 * a document: **where this panel can be reached from, named by interface.**
 *
 * ## Why by interface and never by a list of addresses
 *
 * Measured on the bench board, 2026-09-21: the wire was `192.168.77.7` and the wireless uplink was
 * `192.168.77.8` — **one subnet, two interfaces, opposite answers.** The panel answered on `.8` and
 * on nothing at `.7`. A list of addresses cannot express that; read as a list it looks like one
 * network that works. The name is the only handle a person has on which cable or which radio they
 * are holding, so the name is what this screen prints.
 *
 * ## What this screen derives, and the line it does not cross
 *
 * It derives one thing: which interface a bound address belongs to, by looking the address up in
 * the kernel's own address table. Both halves come from the device and it is a lookup, not a
 * judgement.
 *
 * It deliberately does **not** classify an interface. What an interface *is* — wire, access point,
 * uplink, tunnel — is knowledge about the system and it has exactly one definition, in the platform
 * layer. Linux reports a radio as an Ethernet link, so the wire cannot be inferred from what an
 * interface looks like from here; a second classifier in the browser would read as a convenience and
 * behave as a second source of truth, agreeing with the device until the day it did not.
 *
 * ## The prohibition this screen is supposed to be able to report, and today cannot
 *
 * The panel must answer on every local channel and on **no tunnel at all**. That negative half is
 * enforced as a final refusal step in the daemon, and it records an event when it has anything to
 * remove — because a refusal means the positive half offered a tunnel, which is a defect upstream
 * rather than a lucky save.
 *
 * **None of that reaches the browser.** `GET /api/system` serves `listen` as a port, a list of
 * addresses and the interface names that resolved to nothing; there is no refused set, no withheld
 * set, and no per-address interface name. So the one screen where a person could see the prohibition
 * working is structurally unable to report the one event that says it fired. That is the same shape
 * as a guarantee that holds because control never reaches it — recorded here, requested of the API,
 * and marked on screen as not answered rather than drawn as clean. A blank where a refusal belongs
 * reads as "nothing was refused", and that is the reading this file refuses to produce.
 */
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, profileApi, type InventoryResponse, type StatusResponse, type SystemResponse } from '../lib/api.ts';
import { useProfileEditing } from '../lib/editing.ts';
import { t, tf } from '../lib/i18n.ts';
import { Card, Fold, LongValue, RowList, Screen, type Row } from '../components/ui/index.tsx';
import { ManagementReach } from '../components/ManagementReach.tsx';
import { NetworkRules } from '../components/NetworkRules.tsx';
import {
  AccessPointEditor,
  DnsEditor,
  LocalNetworkEditor,
  UplinkEditor,
} from '../components/ProfileFields.tsx';
import { PendingBar } from '../components/PendingBar.tsx';
import { useProfileTarget } from '../lib/target.ts';

export function Network({ live }: { live: StatusResponse | null }): ReactElement {
  const system = useQuery({ queryKey: ['system'], queryFn: api.system });
  const fetched = useQuery({ queryKey: ['status'], queryFn: api.status, enabled: live === null });
  const inventory = useQuery({ queryKey: ['inventory'], queryFn: api.inventory, staleTime: 60_000 });
  const target = useProfileTarget();
  const editing = useProfileEditing(target.id);
  const status = live ?? fetched.data ?? null;

  const reach = whereThePanelAnswers(system.data, inventory.data);

  return (
    <Screen title={t('nav.network')}>
      {/*
        * The reading first, the setting under it, on every one of these cards.
        *
        * Each pair used to be split across two screens: what the access point **is** was here, and
        * what it **should be** was in the profile editor. The person who has just read that the radio
        * is on channel 1 is the person deciding whether it should be — and a screen that shows the
        * first and sends them elsewhere for the second is how the second came to live on a screen
        * nobody opened. Folded, because reading is the common visit and setting is the rare one.
        */}
      <Card title={t('network.accessPoint')}>
        <RowList rows={accessPointRows(status)} empty={t('status.noAccessPoint')} />
        {editing.draft.draft === null ? null : (
          <Fold summary={t('network.change')}>
            <AccessPointEditor document={editing.draft.draft} />
          </Fold>
        )}
      </Card>

      <Card title={t('network.uplink')}>
        <RowList rows={uplinkRows(status)} empty={t('status.noUplink')} />
        {editing.draft.draft === null ? null : (
          <Fold summary={t('network.change')}>
            <UplinkEditor document={editing.draft.draft} />
          </Fold>
        )}
      </Card>

      {/*
        * The network this device serves, and who answers name lookups on it. Neither had a control
        * anywhere after the profile editor was deleted, and both are read by everything on it: the
        * address range is where every client address comes from, and the resolver is what decides
        * whether a name opens at all.
        */}
      {editing.draft.draft === null ? null : (
        <Card title={t('network.local')}>
          <LocalNetworkEditor document={editing.draft.draft} />
        </Card>
      )}

      {editing.draft.draft === null ? null : (
        <Card title={t('network.names')}>
          <DnsEditor document={editing.draft.draft} />
        </Card>
      )}

      {/*
        * What may leave this network, which is the same question the two cards above ask about
        * addresses and names. The other two fields of the same firewall object are on Tunnels,
        * because what they answer is what happens when a tunnel cannot carry the traffic — the split
        * follows the question, not the object.
        */}
      {editing.draft.draft === null ? null : (
        <Card title={t('network.rules')}>
          <NetworkRules document={editing.draft.draft} />
        </Card>
      )}

      <Card title={t('network.reach')}>
        <p className="muted">{t('network.reachIs')}</p>
        <RowList rows={reachRows(reach, system.data)} empty={t('network.reachUnknown')} />

        {/*
          * Said, not left blank.
          *
          * The refusal is the half of the requirement that catches a defect, and a screen with
          * nothing where it belongs is a screen quietly reporting that nothing was refused. Until
          * the field exists on the wire, the honest rendering is to name which question is
          * unanswered — the same rule as tunnel health on Status.
          */}
        <p className="note">{t('network.refusalsUnreported')}</p>

        {/*
          * The setting under the reading, because they are two halves of one question: the rows above say
          * which interfaces the panel answers on **now**, and this says which it should. Separating them
          * is how the setting came to live in a screen that is being deleted.
          */}
        {editing.draft.draft === null ? null : <ManagementReach document={editing.draft.draft} />}
      </Card>

      {/*
        * Saving stores a document; applying is a separate act. The same bar as Routing and Tunnels,
        * and now literally the same component: three copies of it were three copies that would have
        * disagreed the first time one of them was changed.
        */}
      {editing.draft.draft === null ? null : <PendingBar editing={editing} target={target} />}

      {/*
        * The radios, folded: what the hardware can do is the question behind the question, asked
        * when the answer above is not what somebody expected. Printed in the driver's own words —
        * reducing an interface combination to yes or no hides the reason the answer is what it is,
        * and the reason is the actionable half.
        */}
      <Fold summary={t('network.radios')} count={inventory.data?.radios.length}>
        {(inventory.data?.radios ?? []).map((radio) => (
          <RadioBlock key={radio.phy} radio={radio} />
        ))}
      </Fold>

      <Fold summary={t('status.interfaces')} count={inventory.data?.interfaces.length}>
        <RowList rows={interfaceRows(inventory.data)} empty={t('common.loading')} />
      </Fold>

      {(inventory.data?.notes ?? []).length > 0 ? (
        <Fold summary={t('status.warnings')} count={inventory.data?.notes.length}>
          {(inventory.data?.notes ?? []).map((note) => (
            <p className="note" key={note}>
              {note}
            </p>
          ))}
        </Fold>
      ) : null}
    </Screen>
  );
}

/* ── where the panel answers ─────────────────────────────────────────────────────────────── */

export interface ReachEntry {
  /** The interface name, or `null` for an address no interface claims. */
  interface: string | null;
  addresses: string[];
  /**
   * `true` when the panel is bound on this interface.
   *
   * An interface that is *named in the configuration* and bound to nothing is the exact bench
   * defect, so it is a state of its own rather than an absence from the list.
   */
  answering: boolean;
  /** Named in the configuration and resolved to no address at bind time. */
  unresolved: boolean;
}

/**
 * Joins the bound addresses onto the kernel's address table, by address.
 *
 * Exported so the join can be tested against the bench board's own readings — one subnet, two
 * interfaces, opposite answers — which is the case a lookup keyed on anything coarser gets wrong.
 *
 * An address that matches no interface is kept as an entry with no name rather than dropped. The
 * panel is audible there either way, and an address nobody can attribute is worth more attention
 * than one that is attributed, not less.
 */
export function whereThePanelAnswers(
  system: SystemResponse | undefined,
  inventory: InventoryResponse | undefined,
): ReachEntry[] {
  if (!system) return [];

  const bound = new Set(system.listen.addresses);
  const unresolved = new Set(system.listen.unresolvedInterfaces);
  const entries: ReachEntry[] = [];
  const attributed = new Set<string>();

  for (const link of inventory?.interfaces ?? []) {
    const addresses = link.addresses.map((entry) => entry.address);
    const answering = addresses.filter((address) => bound.has(address));
    for (const address of answering) attributed.add(address);

    // An interface is listed when the panel answers on it, or when it was named and resolved to
    // nothing. An interface that is simply not a management channel is not a finding.
    if (answering.length === 0 && !unresolved.has(link.name)) continue;
    entries.push({
      interface: link.name,
      addresses: answering.length > 0 ? answering : addresses,
      answering: answering.length > 0,
      unresolved: unresolved.has(link.name),
    });
  }

  for (const address of bound) {
    if (attributed.has(address)) continue;
    entries.push({ interface: null, addresses: [address], answering: true, unresolved: false });
  }

  // A name the configuration mentions that the kernel does not report at all is still a fact about
  // the configuration, and losing it would make a typo indistinguishable from a cable being out.
  for (const name of unresolved) {
    if (entries.some((entry) => entry.interface === name)) continue;
    entries.push({ interface: name, addresses: [], answering: false, unresolved: true });
  }

  return entries;
}

function reachRows(entries: ReachEntry[], system: SystemResponse | undefined): Row[] {
  return entries.map((entry) => ({
    id: entry.interface ?? entry.addresses.join(','),
    title: <span className="mono">{entry.interface ?? t('network.noInterface')}</span>,
    badge: (
      <span className={`pill ${entry.answering ? 'ok' : 'warn'}`}>
        {entry.answering ? t('network.answers') : t('network.silent')}
      </span>
    ),
    fields: [
      {
        label: t('network.address'),
        value:
          entry.addresses.length === 0 ? (
            <span className="muted">{t('network.noAddress')}</span>
          ) : (
            <LongValue
              value={entry.addresses.map((address) => `${address}:${system?.listen.port ?? ''}`).join(' ')}
              label={t('network.address')}
            />
          ),
      },
      ...(entry.unresolved ? [{ label: t('network.why'), value: t('network.unresolved') }] : []),
    ],
  }));
}

/* ── the access point and the uplink ─────────────────────────────────────────────────────── */

function accessPointRows(status: StatusResponse | null): Row[] {
  return Object.entries(status?.accessPoints ?? {}).map(([name, ap]) => ({
    id: name,
    title: <span className="mono">{name}</span>,
    badge: (
      <span className={`pill ${ap.status?.state === 'ENABLED' ? 'ok' : 'bad'}`}>
        {ap.status?.state ?? t('common.unknown')}
      </span>
    ),
    fields: [
      {
        label: t('status.channel'),
        value:
          ap.status?.channel == null
            ? '—'
            : `${ap.status.channel}${ap.status.frequencyMhz ? ` · ${ap.status.frequencyMhz} MHz` : ''}`,
      },
      {
        label: t('status.clients'),
        // A list that was cut short is not a count. Same reading, same caveat, as on Clients.
        value: ap.stationsComplete ? String(ap.stations.length) : tf('network.atLeast', ap.stations.length),
      },
    ],
  }));
}

function uplinkRows(status: StatusResponse | null): Row[] {
  return Object.entries(status?.links ?? {}).map(([name, link]) => ({
    id: name,
    title: <span className="mono">{name}</span>,
    badge: (
      <span className={`pill ${link.connected ? 'ok' : 'bad'}`}>
        {link.connected ? t('status.connected') : t('status.disconnected')}
      </span>
    ),
    fields: [
      {
        label: t('status.network'),
        value: link.ssid ? <LongValue value={link.ssid} label={t('status.network')} /> : '—',
      },
      { label: t('status.signal'), value: link.signalDbm == null ? '—' : `${link.signalDbm} dBm` },
      { label: t('status.rate'), value: link.txBitrate?.mbps == null ? '—' : `${link.txBitrate.mbps} Mbit/s` },
    ],
  }));
}

function interfaceRows(inventory: InventoryResponse | undefined): Row[] {
  return (inventory?.interfaces ?? []).map((link) => ({
    id: link.name,
    title: <span className="mono">{link.name}</span>,
    badge: (
      <span className={`pill ${link.operstate === 'UP' ? 'ok' : link.flags.includes('NO-CARRIER') ? 'warn' : ''}`}>
        {link.operstate ?? '?'}
      </span>
    ),
    fields: [
      {
        label: t('network.address'),
        value:
          link.addresses.length === 0 ? (
            <span className="muted">—</span>
          ) : (
            <LongValue
              value={link.addresses.map((entry) => `${entry.address}/${entry.prefixLength}`).join(' ')}
              label={t('network.address')}
            />
          ),
      },
      // A flag list is a long unbreakable-looking run of capitals that grows with the kernel.
      { label: t('status.flags'), value: <LongValue value={link.flags.join(' ')} label={t('status.flags')} /> },
    ],
  }));
}

/* ── radios ──────────────────────────────────────────────────────────────────────────────── */

function RadioBlock({ radio }: { radio: InventoryResponse['radios'][number] }): ReactElement {
  const together = radio.derived.accessPointAndClientTogether;
  const usable = radio.derived.channels.filter((channel) => !channel.disabled);

  return (
    <Fold summary={radio.phy} count={usable.length}>
      <dl className="row-fields">
        <Pair label={t('network.bands')} value={radio.derived.bands.value.join(', ') || '—'} />
        <Pair
          label={t('network.accessPointMode')}
          value={radio.derived.canHostAccessPoint.value ? t('common.yes') : t('common.no')}
        />
        <Pair
          label={t('network.clientMode')}
          value={radio.derived.canHostClient.value ? t('common.yes') : t('common.no')}
        />
        <div className="row-field">
          <dt>{t('network.bothAtOnce')}</dt>
          <dd>
            {together.value.supported ? (
              together.value.sameChannelOnly ? (
                <span className="pill warn">{t('network.sharedChannelOnly')}</span>
              ) : (
                <span className="pill ok">{t('common.yes')}</span>
              )
            ) : (
              <span className="pill bad">{t('common.no')}</span>
            )}
          </dd>
        </div>
        <Pair
          label={t('radio.regulatory')}
          value={radio.reported.regulatory.country ?? t('common.unknown')}
        />
        <div className="row-field">
          <dt>{t('network.scanning')}</dt>
          <dd>
            <span className={`pill ${radio.derived.scanAllowedNow.value ? 'ok' : 'warn'}`}>
              {radio.derived.scanAllowedNow.value ? t('network.allowed') : t('network.refused')}
            </span>
          </dd>
        </div>
      </dl>

      {/*
        * The driver's own words. This is the constraint that decides whether an access point and a
        * Wi-Fi uplink can share one radio, and a rendering that reduced it to yes or no would hide
        * the reason — which is the part somebody acts on.
        */}
      <Fold summary={t('network.combinations')} count={radio.reported.interfaceCombinations.length}>
        {radio.reported.interfaceCombinations.map((combination) => (
          <p className="journal-line" key={combination.text}>
            {combination.text}
          </p>
        ))}
      </Fold>

      <Fold summary={t('network.channels')} count={usable.length}>
        <RowList
          rows={usable.map((channel) => ({
            id: String(channel.frequencyMhz),
            title: <span className="mono">{channel.channel ?? channel.frequencyMhz}</span>,
            badge: <span className="pill">{channel.band}</span>,
            fields: [
              { label: t('network.frequency'), value: `${channel.frequencyMhz} MHz` },
              {
                // The difference between 23 and 13 dBm is the difference between good coverage and
                // unusable coverage, so the limit is shown per channel rather than per band.
                label: t('network.maxPower'),
                value: channel.maxTxPowerDbm === null ? t('common.unknown') : `${channel.maxTxPowerDbm} dBm`,
              },
              ...(channel.requiresRadarDetection
                ? [{ label: t('network.note'), value: t('network.radar') }]
                : []),
            ],
          }))}
          empty={t('network.noChannels')}
        />
      </Fold>
    </Fold>
  );
}

function Pair({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="row-field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
