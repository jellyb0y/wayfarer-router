/**
 * **OpenVPN — an `.ovpn` file.**
 *
 * That is the whole of what the owner holds, and it is the whole of what this screen asks for. What
 * used to be here was a text box wanting a command line with flags beside a second text box holding
 * an entire client configuration as a string, where a wrong flag stopped the client silently.
 *
 * The file is taken verbatim and marked as a credential, because asking somebody to decompose a file
 * his provider generated is asking him to do a job he cannot check. Its `remote` lines are not
 * authoritative and nothing here says they are: the catalogue entry writes those.
 */
import type { ReactElement } from 'react';
import { readAt, useDraft } from '../../lib/draft.ts';
import { Field, Fold, SecretField, SelectField, TextField } from '../ui/index.tsx';
import type { Tunnel } from './common.tsx';

/**
 * The fields both OpenVPN-bearing entries share.
 *
 * Shared by composition rather than by one editor with a flag, for the same reason the schema shares
 * them that way: `Cloak + OpenVPN` is one catalogue entry, not a composition the owner performs.
 */
export function OpenVpnFileFields({
  index,
  config,
  fileHelp,
}: {
  index: number;
  config: Record<string, unknown>;
  /** Only the obfuscated entry says anything extra about the file, so only it passes this. */
  fileHelp?: string;
}): ReactElement {
  const draft = useDraft();
  const base = `/tunnels/${index}/config`;
  const auth = config['auth'] as Record<string, unknown> | undefined;

  return (
    <>
      <SecretField
        pointer={`${base}/profile`}
        label="The .ovpn file"
        value={config['profile']}
        blob
        help={fileHelp ?? 'Paste it exactly as your provider gave it, certificates and keys included.'}
      />

      {/*
        * The pair is created and removed as a whole. A user name with no password is not a state
        * anything can use, and a control per half would let somebody leave one there — which
        * validates as an account that cannot authenticate.
        */}
      <Field
        pointer={`${base}/auth`}
        label="Needs sign-in"
        help="Only when the server wants a user name and password as well as the file."
      >
        <input
          type="checkbox"
          checked={auth !== undefined}
          onChange={(event) => draft.set(`${base}/auth`, event.target.checked ? {} : undefined)}
        />
      </Field>
      {auth === undefined ? null : (
        <>
          <TextField pointer={`${base}/auth/username`} label="User name" value={auth['username']} />
          <SecretField pointer={`${base}/auth/password`} label="Password" value={auth['password']} />
        </>
      )}

      <Fold summary="Advanced">
        <TextField
          pointer={`${base}/interfaceSuffix`}
          label="Interface tag"
          value={config['interfaceSuffix']}
          help="Up to six letters or digits; left empty, one is derived."
        />
      </Fold>
    </>
  );
}

/**
 * Plain OpenVPN only: what this tunnel's own connection to its server goes through.
 *
 * Not in `OpenVpnFileFields`, which `Cloak + OpenVPN` shares: there the server is a local obfuscation
 * client, and it has no proxy setting for the daemon to use (see `OpenVpnConfig.via` in the schema).
 * The list is the other enabled tunnels of the draft, so a tunnel added a moment ago is offered before
 * it is saved; the daemon refuses a disabled one, itself, or a loop, on the field.
 */
function ConnectVia({ index, tunnel }: { index: number; tunnel: Tunnel }): ReactElement {
  const document = useDraft((state) => state.draft);
  const tunnels = (readAt(document, '/tunnels') as Tunnel[] | undefined) ?? [];
  const groups = (readAt(document, '/groups') as Record<string, unknown>[] | undefined) ?? [];
  const config = (tunnel['config'] as Record<string, unknown>) ?? {};
  // A tunnel or a group: either can carry another tunnel's connection.
  const others = [
    ...groups.filter((group) => group['enabled'] !== false),
    ...tunnels.filter((other) => other['id'] !== tunnel['id'] && other['enabled'] !== false),
  ].map((other) => ({ value: String(other['id']), title: `Through ${String(other['name'] ?? other['id'])}` }));
  return (
    <SelectField
      pointer={`/tunnels/${index}/config/via`}
      label="Connect"
      value={config['via']}
      options={[{ value: 'failover', title: 'Through the egress' }, ...others]}
      absent={{ title: 'Directly', write: undefined }}
      help="For a server that cannot be reached from here. Through the egress, it follows whichever member its group is on and reconnects when that changes."
    />
  );
}

export function OpenVpnEditor({ index, tunnel }: { index: number; tunnel: Tunnel }): ReactElement {
  return (
    <>
      <OpenVpnFileFields index={index} config={(tunnel['config'] as Record<string, unknown>) ?? {}} />
      <ConnectVia index={index} tunnel={tunnel} />
    </>
  );
}
