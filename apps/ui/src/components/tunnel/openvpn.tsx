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
import { useDraft } from '../../lib/draft.ts';
import { Field, Fold, SecretField, TextField } from '../ui/index.tsx';
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

export function OpenVpnEditor({ index, tunnel }: { index: number; tunnel: Tunnel }): ReactElement {
  return <OpenVpnFileFields index={index} config={(tunnel['config'] as Record<string, unknown>) ?? {}} />;
}
