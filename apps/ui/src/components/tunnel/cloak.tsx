/**
 * **Cloak + OpenVPN — an `.ovpn` file, plus the entry points that front it.**
 *
 * One catalogue entry rather than a tunnel a person composes with a transport, because the two
 * arrive together and are chosen together. What the owner holds is the file and a list of places the
 * obfuscation layer can connect to; the bench's corporate tunnel has four of them, at four different
 * sites, each pretending to be a different domain.
 *
 * **Several per tunnel is the normal case, and nothing here ever walked the list.** Measured from a
 * redacted export of the bench profile, 2026-09-21: five account identifiers reached a *redacted*
 * export in clear, because every entry point lived inside one unmarked string field and no code and
 * no screen ever descended into it. Each field is its own control now, and the credential among them
 * is the one marked as such.
 *
 * ## The order is data
 *
 * It becomes the order of the `remote` lines in the generated file, which is the order the client
 * tries them in. Moving an entry point up is a change to failover, not to a display, so it is an
 * edit — and it is two buttons rather than a drag, because a drag target needs a pointer to find.
 */
import type { ReactElement } from 'react';
import { useDraft } from '../../lib/draft.ts';
import { CheckField, Fold, NumberField, SecretField, SelectField, TextField } from '../ui/index.tsx';
import type { Tunnel } from './common.tsx';
import { OpenVpnFileFields } from './openvpn.tsx';

type EntryPoint = Record<string, unknown>;

const ENCRYPTION = [
  { value: 'plain', title: 'None' },
  { value: 'aes-gcm', title: 'AES-GCM' },
  { value: 'aes-256-gcm', title: 'AES-256-GCM' },
  { value: 'chacha20-poly1305', title: 'ChaCha20-Poly1305' },
] as const;

const SIGNATURE = [
  { value: 'chrome', title: 'Chrome' },
  { value: 'firefox', title: 'Firefox' },
  { value: 'safari', title: 'Safari' },
  { value: 'ios', title: 'iOS' },
] as const;

const TRANSPORT = [
  { value: 'direct', title: 'Straight to it' },
  { value: 'cdn', title: 'Through a network' },
] as const;

/**
 * A new entry point, with the schema's own defaults written out rather than left to be inferred.
 *
 * **The id is minted against the ids that exist, never against the length of the list.** Counting
 * produced `entry-${length + 1}`, which is unique only while nothing has ever been removed: delete
 * the second of three and add one, and the new entry is `entry-3` beside the old `entry-3`.
 *
 * The cost is not a duplicate string on a screen. The generated systemd unit name and the
 * obfuscation client's configuration file path are both derived from this id, so two entry points
 * sharing one id are two units and two files with one name each — last write wins, silently — and
 * the `.ovpn` gains a `127.0.0.1:<port>` line pointing at a client that was overwritten and is not
 * listening. Nothing refuses it and nothing on any screen says so.
 *
 * So the id is the lowest `entry-N` **not already taken**, which cannot collide by construction
 * rather than by the list happening not to have been edited. Sequential rather than random because
 * these names end up in unit files a person reads, and a number they can count is worth more there
 * than an identifier that is unique in a way nobody can check by eye.
 */
function blankEntryPoint(taken: readonly EntryPoint[]): EntryPoint {
  const used = new Set(taken.map((entry) => String(entry['id'] ?? '')));
  let ordinal = 1;
  while (used.has(`entry-${ordinal}`)) ordinal += 1;
  return {
    id: `entry-${ordinal}`,
    host: '',
    port: 443,
    publicKey: '',
    proxyMethod: 'openvpn',
    encryptionMethod: 'aes-gcm',
    serverName: '',
    browserSignature: 'chrome',
    transport: 'direct',
  };
}

export function CloakOpenVpnEditor({ index, tunnel }: { index: number; tunnel: Tunnel }): ReactElement {
  const draft = useDraft();
  const config = (tunnel['config'] as Record<string, unknown>) ?? {};
  const entryPoints = (config['entryPoints'] as EntryPoint[] | undefined) ?? [];
  const base = `/tunnels/${index}/config`;

  const write = (next: EntryPoint[]): void => draft.set(`${base}/entryPoints`, next);

  const move = (position: number, by: number): void => {
    const next = [...entryPoints];
    const target = position + by;
    if (target < 0 || target >= next.length) return;
    [next[position], next[target]] = [next[target]!, next[position]!];
    write(next);
  };

  return (
    <>
      <OpenVpnFileFields
        index={index}
        config={config}
        fileHelp="Paste it as your provider gave it; its remote lines are replaced below."
      />

      <div className="field-label">Entry points</div>
      <p className="muted field-help">
        Tried in this order, so moving one up is a change to failover.
      </p>

      {entryPoints.length === 0 ? (
        <p className="note">
          No entry points. This tunnel cannot connect at all until it has one — the obfuscation layer
          has nowhere to reach, and the file's own remote lines are not used.
        </p>
      ) : null}

      {/*
        * The pointer for the list itself goes on the list, not on a label with no control under it.
        * Adding, removing and reordering all write `entryPoints` as a whole, so this element **is**
        * the control for that position, and the coverage manifest should see it as one.
        */}
      <ol className="entry-list" data-pointer={`${base}/entryPoints`}>
        {entryPoints.map((entry, position) => (
          <li key={String(entry['id'] ?? position)} className="entry-item">
            <div className="row-head">
              <span className="row-title">
                {position + 1} · {String(entry['name'] ?? entry['host'] ?? 'New entry point')}
              </span>
            </div>
            <div className="row-actions">
              <button type="button" onClick={() => move(position, -1)} disabled={position === 0}>
                Up
              </button>
              <button type="button" onClick={() => move(position, 1)} disabled={position === entryPoints.length - 1}>
                Down
              </button>
              <button
                type="button"
                onClick={() => write(entryPoints.filter((_unused, other) => other !== position))}
              >
                Remove
              </button>
            </div>
            <Fold summary="Edit">
              <EntryPointFields index={index} position={position} entry={entry} />
            </Fold>
          </li>
        ))}
      </ol>

      <div className="row-actions">
        <button type="button" onClick={() => write([...entryPoints, blankEntryPoint(entryPoints)])}>
          Add an entry point
        </button>
      </div>
    </>
  );
}

function EntryPointFields({
  index,
  position,
  entry,
}: {
  index: number;
  position: number;
  entry: EntryPoint;
}): ReactElement {
  const base = `/tunnels/${index}/config/entryPoints/${position}`;
  return (
    <>
      <TextField pointer={`${base}/name`} label="Name" value={entry['name']} help="What you call this site." />
      <TextField pointer={`${base}/host`} label="Address" value={entry['host']} />
      <NumberField pointer={`${base}/port`} label="Port" value={entry['port']} min={1} max={65535} />
      {/*
        * Called an identifier by every provider that issues one, and a credential regardless. It is
        * marked in the schema, which is what keeps it out of a redacted export — five of these left
        * the bench in clear because the mark was on one shape and not on its twin.
        */}
      <SecretField
        pointer={`${base}/uid`}
        label="Account id"
        value={entry['uid']}
        help="A credential, despite the name: it is removed from an export that redacts."
      />
      <TextField
        pointer={`${base}/publicKey`}
        label="Server key"
        value={entry['publicKey']}
        help="Public by construction — the client encrypts to it — so it stays in a redacted export."
      />
      <TextField
        pointer={`${base}/serverName`}
        label="Pretends to reach"
        value={entry['serverName']}
        help="The domain this connection appears to be going to."
      />

      <Fold summary="Advanced">
        <SelectField
          pointer={`${base}/transport`}
          label="How it connects"
          value={String(entry['transport'] ?? 'direct')}
          options={TRANSPORT}
          help="Through a network means a content delivery network carries it; straight to it reaches the address above."
        />
        <SelectField
          pointer={`${base}/encryptionMethod`}
          label="Encryption"
          value={String(entry['encryptionMethod'] ?? 'aes-gcm')}
          options={ENCRYPTION}
        />
        <SelectField
          pointer={`${base}/browserSignature`}
          label="Looks like"
          value={String(entry['browserSignature'] ?? 'chrome')}
          options={SIGNATURE}
        />
        <TextField
          pointer={`${base}/proxyMethod`}
          label="Service name"
          value={entry['proxyMethod']}
          help="The name the provider gave this service, not a display name."
        />
        <NumberField
          pointer={`${base}/connections`}
          label="Connections"
          value={entry['connections']}
          min={1}
          max={64}
        />
        <NumberField
          pointer={`${base}/streamTimeoutSeconds`}
          label="Stream timeout"
          value={entry['streamTimeoutSeconds']}
          min={1}
          max={3600}
          help="Seconds."
        />
        <CheckField
          pointer={`${base}/udp`}
          label="Carries UDP"
          checked={entry['udp'] !== false}
          help="OpenVPN over UDP needs this."
        />
      </Fold>
    </>
  );
}
