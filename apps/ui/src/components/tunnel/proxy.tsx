/**
 * **Proxy — an address, a port, and sometimes a sign-in.**
 *
 * One screen for all three kinds, because what the owner holds is *a proxy*: his provider told him
 * which of HTTP, HTTPS and SOCKS it speaks, and that is an answer he already has rather than a
 * product he had to choose between. Three screens differing by one dropdown would have made him
 * choose a catalogue entry before he could type an address.
 *
 * ## The two fields that belong to one answer only
 *
 * The handshake name and the trusted certificate exist only when there is a TLS handshake, so they
 * are drawn for **HTTPS and for nothing else** — the same rule the Reality fields follow one screen
 * along. Drawn beside a SOCKS proxy they would be two boxes that change nothing, and worse: the
 * daemon's entry *refuses* a configuration that sets them on a proxy with no handshake, so offering
 * them blankly would be an interface that leads somebody to a refusal it drew for him.
 *
 * **Hiding a field does not remove it, and this screen produced the refusal it was written to avoid.**
 * Fill in a certificate on HTTPS, switch the type to SOCKS, and the control disappears while the
 * draft keeps the value; the plan is then refused pointing at a field that is no longer on any
 * screen, which is the least clearable error a product can have. So the two TLS fields are
 * **cleared when the type stops being HTTPS** — an ordinary draft write, in the same pending change
 * as the choice that caused it, so Review shows both. The entry's own header used to say that
 * reaching its refusal meant a document had arrived some other way; it said so while this screen was
 * the thing producing it, and that sentence is corrected there too.
 *
 * ## There is no box that turns certificate checking off
 *
 * A subscription link asking for `allowInsecure` is refused by this product, naming the parameter,
 * because that switch removes the only check distinguishing a tunnel from a pipe to whoever
 * answered. The need behind it is real and it is answered here by **supplying the certificate**
 * instead: verification stays on and checks against what the owner pasted.
 */
import type { ReactElement } from 'react';
import { useDraft } from '../../lib/draft.ts';
import { ChoiceField, Field, NumberField, SecretField, TextField, TextList } from '../ui/index.tsx';
import type { Tunnel } from './common.tsx';

/**
 * The three answers, each saying what choosing it does to the traffic rather than naming a category.
 *
 * Rule 4: a consequence belongs in the control that causes it. The difference between these three is
 * not a word a person can rank — it is whether the hop to the proxy is encrypted and whether UDP can
 * cross it, and that is what the sentences say.
 */
const TYPES = [
  {
    value: 'socks',
    title: 'SOCKS',
    consequence: 'Carries TCP and UDP, and the hop to the proxy is not encrypted.',
  },
  {
    value: 'http',
    title: 'HTTP',
    consequence: 'TCP only, and the hop to the proxy is not encrypted.',
  },
  {
    value: 'https',
    title: 'HTTPS',
    consequence: 'TCP only, and the hop to the proxy is encrypted with its certificate checked.',
  },
] as const;

export function ProxyEditor({ index, tunnel }: { index: number; tunnel: Tunnel }): ReactElement {
  const draft = useDraft();
  const config = (tunnel['config'] as Record<string, unknown>) ?? {};
  const base = `/tunnels/${index}/config`;
  const type = String(config['type'] ?? 'socks');
  const auth = config['auth'] as Record<string, unknown> | undefined;

  return (
    <>
      <ChoiceField
        pointer={`${base}/type`}
        label="What it speaks"
        value={type}
        options={TYPES}
        onChoose={(chosen) => {
          // The two fields that only mean something on HTTPS. Left behind they are a refusal at a
          // pointer with no control on any screen.
          if (chosen === 'https') return;
          draft.set(`${base}/tlsServerName`, undefined);
          draft.set(`${base}/tlsCertificate`, undefined);
        }}
      />

      <TextField pointer={`${base}/server`} label="Address" value={config['server']} />
      <NumberField pointer={`${base}/port`} label="Port" value={config['port']} min={1} max={65535} />

      {/*
        * Created and removed as a whole, exactly as an OpenVPN account is. A user name with no
        * password is not a state anything can use, and a control per half lets somebody leave one
        * behind — which validates as an account that cannot authenticate.
        */}
      <Field
        pointer={`${base}/auth`}
        label="Needs sign-in"
        help="Only when the proxy asks for a user name and password."
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

      {/*
        * HTTPS only. There is no handshake on the other two to put either of these in, and the
        * daemon refuses rather than dropping them — so drawing them here would be this screen
        * offering a field that makes the profile unplannable.
        */}
      {type === 'https' ? (
        <>
          <TextField
            pointer={`${base}/tlsServerName`}
            label="Handshake name"
            value={config['tlsServerName']}
            help="Left empty, the address above is used."
          />
          {/*
            * The expected shape is in the help, because nothing downstream can say it kindly: a
            * value that is not PEM travels all the way to the core's start-up and fails there, in a
            * journal, about a file nobody wrote by hand. Naming the two marker lines costs one
            * sentence and is the difference between pasting the right half of a file and the wrong
            * one. A parser here would be a second implementation of something the core already does
            * properly, so the refusal below checks only what it can check without being one.
            */}
          <TextList
            pointer={`${base}/tlsCertificate`}
            label="Trusted certificate"
            value={config['tlsCertificate'] as string[] | undefined}
            help="PEM, from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----, pasted whole."
          />
        </>
      ) : null}
    </>
  );
}
