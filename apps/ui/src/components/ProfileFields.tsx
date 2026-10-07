/**
 * The profile fields that had no home once the old editor was deleted.
 *
 * **They were found by asking what else lived on the screen that was being deleted**, and the answer
 * was thirty positions: the network name, the Wi-Fi passphrase, the range of addresses handed to
 * clients, the uplink credentials, the resolvers. E10 put "the access point, and the uplink it is
 * using" on Network; the screen was built answering that question and read-only, and no task owned
 * the move. Deleting the old editor without this file would have left all of it reachable only
 * through the API — **the owner's original complaint, committed by the change written to remove it.**
 *
 * They live here rather than inside `Network.tsx` because Network is a screen about what is true
 * right now and these are controls about what should be; keeping them separable is also what let the
 * move be reviewed as a move rather than as a rewrite of a screen that was already measured.
 *
 * Every control is stamped with the position it writes, like every other control in this interface,
 * so the coverage manifest sees them the moment they render and loses them the moment they do not.
 */
import type { ReactElement } from 'react';
import { readAt, useDraft } from '../lib/draft.ts';
import {
  BooleanChoiceField,
  CheckField,
  Fold,
  NumberField,
  SecretField,
  SelectField,
  TextField,
  TextList,
} from './ui/index.tsx';

const BANDS = [
  { value: '2.4GHz', title: '2.4 GHz' },
  { value: '5GHz', title: '5 GHz' },
  { value: '6GHz', title: '6 GHz' },
] as const;

const WIDTHS = [
  { value: '20', title: '20 MHz' },
  { value: '40', title: '40 MHz' },
  { value: '80', title: '80 MHz' },
  { value: '160', title: '160 MHz' },
] as const;

const AP_BINDINGS = [
  { value: 'phy-builtin', title: 'The built-in radio' },
  { value: 'phy-usb', title: 'A USB radio' },
  { value: 'mac', title: 'By hardware address' },
  { value: 'bus-path', title: 'By where it is plugged in' },
] as const;

const UPLINK_BINDINGS = [
  { value: 'any-ethernet', title: 'Any wired port' },
  { value: 'phy-builtin', title: 'The built-in radio' },
  { value: 'phy-usb', title: 'A USB radio' },
  { value: 'mac', title: 'By hardware address' },
  { value: 'bus-path', title: 'By where it is plugged in' },
] as const;

/**
 * The two fields every role has, written once because the question is the same wherever it is asked.
 *
 * The schema marks them on the declaration rather than at each use for that reason, and the same
 * argument holds here: the access point's rename and an uplink's rename are the same act, and two
 * copies of these sentences would be two copies that drifted.
 *
 * Both are drawn as a choice rather than as a checkbox because **both answers have a consequence.**
 * A cleared checkbox says nothing, and what it would be saying here is *this interface keeps a name
 * the kernel may renumber* and *the plan will refuse rather than write over another manager* — the
 * halves nobody guesses.
 */
const PIN_NAME = [
  {
    value: false,
    title: 'Keep the current one',
    consequence:
      'Applies now with no reboot, but the kernel may renumber it after a dongle moves.',
  },
  {
    value: true,
    title: 'Pin a fixed name',
    consequence:
      'Takes effect at the next boot, and the rename drops the link — so make it a second change.',
  },
] as const;

const TAKE_OVER = [
  {
    value: false,
    title: 'Leave it alone',
    consequence:
      'If another manager already configures this interface, the plan stops and names the file.',
  },
  {
    value: true,
    title: 'Move its file aside',
    consequence:
      'The other manager’s file is moved aside, never deleted, and a revert puts it back.',
  },
] as const;

const UPLINK_KINDS = [
  { value: 'ethernet', title: 'A cable' },
  { value: 'wifi-sta', title: 'A Wi-Fi network' },
] as const;

const UPLINK_BANDS = [
  { value: '2.4GHz', title: '2.4 GHz' },
  { value: '5GHz', title: '5 GHz' },
  { value: '6GHz', title: '6 GHz' },
] as const;

const DNS_STRATEGIES = [
  { value: 'ipv4_only', title: 'IPv4 only' },
  { value: 'prefer_ipv4', title: 'Prefer IPv4' },
  { value: 'prefer_ipv6', title: 'Prefer IPv6' },
  { value: 'ipv6_only', title: 'IPv6 only' },
] as const;

/** The profile's own name and note. Not the device's name, which nothing here can set. */
export function ProfileIdentityEditor({ document }: { document: Record<string, unknown> }): ReactElement {
  const meta = (readAt(document, '/meta') as Record<string, unknown> | undefined) ?? {};
  return (
    <>
      <TextField pointer="/meta/name" label="Profile name" value={meta['name']} />
      <TextField
        pointer="/meta/description"
        label="Note"
        value={meta['description']}
        help="For whoever opens this profile next, including you."
      />
    </>
  );
}

/** This device's own address on the network it serves, and the range it hands out. */
export function LocalNetworkEditor({ document }: { document: Record<string, unknown> }): ReactElement {
  const network = (readAt(document, '/network') as Record<string, unknown> | undefined) ?? {};
  const dhcp = (network['dhcp'] as Record<string, unknown> | undefined) ?? {};
  return (
    <>
      <TextField
        pointer="/network/cidr"
        label="This device’s address"
        value={network['cidr']}
        help="With its prefix, such as 10.44.0.1/24 — every client address comes out of it."
      />
      <CheckField
        pointer="/network/dhcp/enabled"
        label="Hand out addresses"
        checked={dhcp['enabled'] !== false}
        help="Turned off, every device joining this network needs an address set by hand before it can reach anything."
      />
      <TextField pointer="/network/dhcp/from" label="Range from" value={dhcp['from']} />
      <TextField pointer="/network/dhcp/to" label="Range to" value={dhcp['to']} />
      <NumberField pointer="/network/dhcp/leaseHours" label="Lease hours" value={dhcp['leaseHours']} min={1} />
    </>
  );
}

/**
 * The access point, which a profile is allowed not to have.
 *
 * `null` is a valid, complete profile — a board with no radio, or one reached over a cable. So the
 * absence is a state with a control to leave it, never a blank that reads as a broken document.
 */
export function AccessPointEditor({ document }: { document: Record<string, unknown> }): ReactElement {
  const draft = useDraft();
  const accessPoint = readAt(document, '/accessPoint') as Record<string, unknown> | null | undefined;

  if (accessPoint === null || accessPoint === undefined) {
    return (
      <>
        <p className="muted">
          No access point in this profile. That is a complete profile: this device serves whatever is
          plugged into it and broadcasts nothing.
        </p>
        <div className="row-actions">
          <button
            type="button"
            onClick={() =>
              draft.set('/accessPoint', {
                bind: { by: 'phy-builtin' },
                radio: { band: '2.4GHz', channel: 1, width: 20, country: '00', hidden: false },
                ssid: 'Wayfarer',
                acceptChannelFollowsUplink: false,
              })
            }
          >
            Add an access point
          </button>
        </div>
      </>
    );
  }

  const radio = (accessPoint['radio'] as Record<string, unknown> | undefined) ?? {};
  const bind = (accessPoint['bind'] as Record<string, unknown> | undefined) ?? {};

  return (
    <>
      <TextField pointer="/accessPoint/ssid" label="Network name" value={accessPoint['ssid']} />
      <SecretField
        pointer="/accessPoint/passphrase"
        label="Passphrase"
        value={accessPoint['passphrase']}
        help="Empty means an open network: anyone in range joins, and everything they send is readable in the air."
      />
      <SelectField pointer="/accessPoint/radio/band" label="Band" value={String(radio['band'] ?? '2.4GHz')} options={BANDS} />
      <NumberField pointer="/accessPoint/radio/channel" label="Channel" value={radio['channel']} min={1} />
      <SelectField
        pointer="/accessPoint/radio/width"
        label="Channel width"
        value={String(radio['width'] ?? 20)}
        options={WIDTHS}
      />
      <TextField
        pointer="/accessPoint/radio/country"
        label="Country code"
        value={radio['country']}
        help="Decides which channels and powers are legal here; 00 is the safe default."
      />
      <CheckField
        pointer="/accessPoint/radio/hidden"
        label="Hide the name"
        checked={radio['hidden'] === true}
        help="Hiding it stops nothing and makes every device that knows it announce the name wherever it goes."
      />

      <Fold summary="Which radio">
        <SelectField
          pointer="/accessPoint/bind/by"
          label="Chosen by"
          value={String(bind['by'] ?? 'phy-builtin')}
          options={AP_BINDINGS}
        />
        {bind['by'] === 'phy-builtin' ? null : (
          <TextField pointer="/accessPoint/bind/value" label="Identifier" value={bind['value']} />
        )}
        <BooleanChoiceField
          pointer="/accessPoint/pinName"
          label="Interface name"
          value={accessPoint['pinName'] === true}
          options={PIN_NAME}
        />
        <BooleanChoiceField
          pointer="/accessPoint/takeOverInterface"
          label="If already claimed"
          value={accessPoint['takeOverInterface'] === true}
          options={TAKE_OVER}
        />
        {/*
          * The consequence is inside the control because it is what the operator is agreeing to: a
          * radio carrying both an access point and a Wi-Fi uplink serves them on one channel, which
          * the upstream network chooses and can change without asking. Without the acknowledgement
          * the plan refuses and says so, which is better than a surprise.
          */}
        <CheckField
          pointer="/accessPoint/acceptChannelFollowsUplink"
          label="Channel may follow"
          checked={accessPoint['acceptChannelFollowsUplink'] === true}
          help="Needed only when this radio also carries an uplink, which then chooses the channel."
        />
      </Fold>

      <div className="row-actions">
        <button type="button" onClick={() => draft.set('/accessPoint', null)}>
          Remove the access point
        </button>
      </div>
    </>
  );
}

/** The ways out. Empty is valid and means this device serves its own network and nothing beyond it. */
export function UplinkEditor({ document }: { document: Record<string, unknown> }): ReactElement {
  const draft = useDraft();
  const uplinks = (readAt(document, '/uplinks') as Record<string, unknown>[] | undefined) ?? [];

  const add = (kind: 'ethernet' | 'wifi-sta'): void => {
    const taken = new Set(uplinks.map((uplink) => String(uplink['id'])));
    const prefix = kind === 'ethernet' ? 'wan-eth' : 'wan-wifi';
    let counter = uplinks.length;
    while (taken.has(`${prefix}-${counter}`)) counter += 1;
    draft.set('/uplinks', [
      ...uplinks,
      {
        id: `${prefix}-${counter}`,
        kind,
        priority: (kind === 'ethernet' ? 10 : 20) + uplinks.length,
        enabled: true,
        bind: { by: kind === 'ethernet' ? 'any-ethernet' : 'phy-builtin' },
        config: kind === 'ethernet' ? { dhcp: true } : { ssid: '' },
      },
    ]);
  };

  return (
    <>
      {uplinks.length === 0 ? (
        <p className="muted">
          No uplink. This device serves its local network and reaches nothing beyond it — which is a
          valid profile, not an unfinished one.
        </p>
      ) : (
        <p className="muted">Lower priority wins. The rest wait as failover.</p>
      )}

      {/* The list is the control for `/uplinks`: adding and removing write that position whole. */}
      <ol className="tunnel-list" data-pointer="/uplinks">
        {uplinks.map((uplink, index) => {
          const bind = (uplink['bind'] as Record<string, unknown> | undefined) ?? {};
          const config = (uplink['config'] as Record<string, unknown> | undefined) ?? {};
          return (
            <li key={String(uplink['id'] ?? index)} className="tunnel-item">
              <div className="row-head">
                <span className="row-title">{String(uplink['id'] ?? '')}</span>
                <span className="row-badge pill">{uplink['kind'] === 'wifi-sta' ? 'Wi-Fi' : 'Cable'}</span>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  onClick={() => draft.set('/uplinks', uplinks.filter((_unused, other) => other !== index))}
                >
                  Remove
                </button>
              </div>
              <Fold summary="Edit">
                <TextField pointer={`/uplinks/${index}/id`} label="Name" value={uplink['id']} />
                <SelectField
                  pointer={`/uplinks/${index}/kind`}
                  label="What it is"
                  value={String(uplink['kind'] ?? 'ethernet')}
                  options={UPLINK_KINDS}
                />
                {/*
                  * Kept rather than deleted, which is the whole reason this is a field and not the
                  * Remove button above. An uplink switched off keeps its credentials and its binding,
                  * so a cable that is unplugged for a month does not cost somebody the passphrase.
                  */}
                <CheckField
                  pointer={`/uplinks/${index}/enabled`}
                  label="In use"
                  checked={uplink['enabled'] !== false}
                  help="Turned off, it is never brought up or chosen as failover, and its settings are kept."
                />
                <NumberField
                  pointer={`/uplinks/${index}/priority`}
                  label="Priority"
                  value={uplink['priority']}
                  min={0}
                  help="Lower wins; two with the same number leave the choice to the device."
                />
                <SelectField
                  pointer={`/uplinks/${index}/bind/by`}
                  label="Which interface"
                  value={String(bind['by'] ?? 'any-ethernet')}
                  options={UPLINK_BINDINGS}
                />
                {bind['by'] === 'any-ethernet' || bind['by'] === 'phy-builtin' ? null : (
                  <TextField pointer={`/uplinks/${index}/bind/value`} label="Identifier" value={bind['value']} />
                )}
                <BooleanChoiceField
                  pointer={`/uplinks/${index}/pinName`}
                  label="Interface name"
                  value={uplink['pinName'] === true}
                  options={PIN_NAME}
                />
                <BooleanChoiceField
                  pointer={`/uplinks/${index}/takeOverInterface`}
                  label="If already claimed"
                  value={uplink['takeOverInterface'] === true}
                  options={TAKE_OVER}
                />
                {uplink['kind'] === 'wifi-sta' ? (
                  <>
                    <TextField
                      pointer={`/uplinks/${index}/config/ssid`}
                      label="Network name"
                      value={config['ssid']}
                    />
                    <SecretField
                      pointer={`/uplinks/${index}/config/psk`}
                      label="Passphrase"
                      value={config['psk']}
                    />
                    {/*
                      * Not answering is the useful answer here, and it is a value rather than a gap:
                      * a network published on both bands is joined on whichever one the radio hears
                      * better, and pinning a band it is not on that evening is how an uplink stops
                      * associating for a reason nothing on the screen explains.
                      */}
                    <SelectField
                      pointer={`/uplinks/${index}/config/band`}
                      label="Band"
                      value={config['band']}
                      options={UPLINK_BANDS}
                      absent={{ title: 'Whichever it is on', write: null }}
                      help="Pinning a band this network is not using stops it associating at all."
                    />
                    {/*
                      * A hardware address, so it is a typed field rather than a list of what the
                      * device can hear: the scan results are not on the wire yet, and a chooser drawn
                      * over nothing is a chooser with one empty answer in it.
                      */}
                    <TextField
                      pointer={`/uplinks/${index}/config/bssid`}
                      label="Which access point"
                      value={config['bssid']}
                      placeholder="90:de:80:47:b4:b4"
                      help="For a network with several access points; left empty, the radio may move."
                    />
                    <CheckField
                      pointer={`/uplinks/${index}/config/hidden`}
                      label="Hidden network"
                      checked={config['hidden'] === true}
                      help="One that does not broadcast its name, so this device announces it instead."
                    />
                  </>
                ) : null}

                {/*
                  * How this uplink is addressed, asked of **both kinds**.
                  *
                  * It was drawn for a cable only, because the schema carried these three fields on the
                  * wired branch alone — so a Wi-Fi uplink with DHCP turned off had nowhere to say what
                  * to use instead. That was reported as a schema asymmetry rather than worked around
                  * here, and the declaration is now shared by both kinds: the two differ in how they
                  * *join* a network, not in how one is addressed.
                  *
                  * The three fields appear only when the box is cleared, and their absence is said in
                  * words rather than left as a gap — a screen that goes quiet where an answer belongs
                  * is a screen answering.
                  */}
                <CheckField
                  pointer={`/uplinks/${index}/config/dhcp`}
                  label="Learn the address"
                  checked={config['dhcp'] !== false}
                  help="Turned off, this uplink needs an address, a gateway and a resolver set by hand."
                />
                {config['dhcp'] === false ? (
                  <>
                    <TextField
                      pointer={`/uplinks/${index}/config/address`}
                      label="Address"
                      value={config['address']}
                      help="With its prefix length, such as 192.0.2.44/24."
                    />
                    <TextField
                      pointer={`/uplinks/${index}/config/gateway`}
                      label="Gateway"
                      value={config['gateway']}
                      help="Where this uplink sends everything it is not on the same network as."
                    />
                    <TextList
                      pointer={`/uplinks/${index}/config/dns`}
                      label="Resolvers"
                      value={config['dns'] as string[] | undefined}
                      help="One per line; with none, nothing on this uplink resolves a name."
                    />
                  </>
                ) : (
                  <p className="muted field-help">
                    Turn it off to set the address, gateway and resolvers here instead.
                  </p>
                )}
              </Fold>
            </li>
          );
        })}
      </ol>

      <div className="row-actions">
        <button type="button" onClick={() => add('ethernet')}>
          Add a cable uplink
        </button>
        <button type="button" onClick={() => add('wifi-sta')}>
          Add a Wi-Fi uplink
        </button>
      </div>
    </>
  );
}

/** Who answers name lookups, and the one switch that records what was asked. */
export function DnsEditor({ document }: { document: Record<string, unknown> }): ReactElement {
  const dns = (readAt(document, '/dns') as Record<string, unknown> | undefined) ?? {};
  return (
    <>
      <TextField pointer="/dns/direct" label="For direct traffic" value={dns['direct']} />
      <TextField pointer="/dns/overTunnel" label="Through a tunnel" value={dns['overTunnel']} />
      <SelectField
        pointer="/dns/strategy"
        label="Address family"
        value={String(dns['strategy'] ?? 'prefer_ipv4')}
        options={DNS_STRATEGIES}
      />
      {/*
        * Written as what it records rather than as what it is called, and off by default, because the
        * thing being switched on is a log of what the people on this network were doing. The operator
        * is entitled to that choice; we are not entitled to make it for them so our own diagnosis is
        * easier. It earns its place because without it a class of fault is unanswerable: "the client
        * never asked us", "we answered wrongly" and "we answered and the client ignored it" look
        * identical from outside.
        */}
      <CheckField
        pointer="/dns/logQueries"
        label="Record lookups"
        checked={dns['logQueries'] === true}
        help="Writes every name every client asks for into the journal; turn it off again afterwards."
      />
    </>
  );
}
