/**
 * **Hysteria 2 — an address, a password, and sometimes an obfuscation password.**
 *
 * There is no box that turns certificate checking off. The field exists in the schema, marked
 * `subscription`: only a feed that states the requirement may set it, and the daemon refuses it on a
 * tunnel made here (`insecure_outside_feed`). Drawing it would be this screen offering a refusal.
 *
 * Obfuscation is created and removed as a whole, like a proxy's sign-in: an obfuscation password that
 * is present and empty validates and fails every handshake.
 */
import type { ReactElement } from 'react';
import { useDraft } from '../../lib/draft.ts';
import { Field, NumberField, SecretField, TextField, TextList } from '../ui/index.tsx';
import type { Tunnel } from './common.tsx';

export function Hysteria2Editor({ index, tunnel }: { index: number; tunnel: Tunnel }): ReactElement {
  const draft = useDraft();
  const config = (tunnel['config'] as Record<string, unknown>) ?? {};
  const base = `/tunnels/${index}/config`;
  const obfuscated = config['obfsPassword'] !== undefined;

  return (
    <>
      <TextField pointer={`${base}/server`} label="Address" value={config['server']} />
      <NumberField pointer={`${base}/port`} label="Port" value={config['port']} min={1} max={65535} />
      <TextList
        pointer={`${base}/serverPorts`}
        label="Port hopping"
        value={config['serverPorts'] as string[] | undefined}
        help="Extra server ports to hop across, one range per line, like 18020:18039. Empty means no hopping."
      />
      <SecretField pointer={`${base}/password`} label="Password" value={config['password']} />
      <Field
        pointer={`${base}/obfsPassword`}
        label="Obfuscated"
        help="Only when the server uses Salamander obfuscation."
      >
        <input
          type="checkbox"
          checked={obfuscated}
          onChange={(event) => draft.set(`${base}/obfsPassword`, event.target.checked ? '' : undefined)}
        />
      </Field>
      {obfuscated ? (
        <SecretField pointer={`${base}/obfsPassword`} label="Obfuscation password" value={config['obfsPassword']} />
      ) : null}
      <TextField
        pointer={`${base}/serverName`}
        label="Handshake name"
        value={config['serverName']}
        help="Left empty, the address above is used."
      />
      <TextList
        pointer={`${base}/alpn`}
        label="ALPN"
        value={config['alpn'] as string[] | undefined}
        help="Usually h3, or empty."
      />
    </>
  );
}
