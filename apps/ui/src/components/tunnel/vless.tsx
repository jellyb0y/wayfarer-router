/**
 * **VLESS — a link, or a subscription.**
 *
 * That is what the owner has: a `vless://` link from a provider, or a feed of them. So the first
 * control on this screen takes one and fills the rest, through **the parser the daemon already uses
 * for subscriptions** rather than a second one written for the browser. Two parsers for one link
 * format is the duplicate-control defect one floor up: they would agree until the day a provider
 * emitted something only one of them understood.
 *
 * ## The entry is named for what the owner holds, and that decides what he is never asked
 *
 * This catalogue entry was called `Xray` until the owner asked why, since Xray is merely the program
 * that runs his subscription. A catalogue named after what we start is named from our side of the
 * product — and the consequence is not a rename. Because the entry is named for the thing rather
 * than for the runner, **which program carries it is not a question he can be asked**: it depends on
 * the configuration, the entry establishes it, and the plan states the choice and the reason.
 *
 * So there is no control for it here, and no sentence on this screen mentions one. The field that
 * actually decides it is `encryption`, which is asked for as what it is — a parameter the link
 * carried — and nowhere described by what it causes. Anything else would be the interface quietly
 * re-opening a decision the catalogue makes, in the one place a person would believe it.
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { parseSubscription } from '@wayfarer/protocols';
import { useDraft } from '../../lib/draft.ts';
import { Fold, NumberField, SecretField, SelectField, TextField, TextList } from '../ui/index.tsx';
import type { Tunnel } from './common.tsx';

const NETWORK = [
  { value: 'tcp', title: 'TCP' },
  { value: 'ws', title: 'WebSocket' },
  { value: 'grpc', title: 'gRPC' },
  { value: 'http', title: 'HTTP' },
  { value: 'quic', title: 'QUIC' },
] as const;

const SECURITY = [
  { value: 'none', title: 'None' },
  { value: 'tls', title: 'TLS' },
  { value: 'reality', title: 'Reality' },
] as const;

export function VlessEditor({ index, tunnel }: { index: number; tunnel: Tunnel }): ReactElement {
  const config = (tunnel['config'] as Record<string, unknown>) ?? {};
  const base = `/tunnels/${index}/config`;
  const security = String(config['security'] ?? 'tls');

  return (
    <>
      <PasteLink index={index} named={typeof tunnel['name'] === 'string' && tunnel['name'] !== ''} />

      <TextField pointer={`${base}/server`} label="Address" value={config['server']} />
      <NumberField pointer={`${base}/port`} label="Port" value={config['port']} min={1} max={65535} />
      <SecretField
        pointer={`${base}/id`}
        label="Account id"
        value={config['id']}
        help="The whole credential in VLESS: anyone holding it is the account."
      />
      <SelectField
        pointer={`${base}/network`}
        label="Carried over"
        value={String(config['network'] ?? 'tcp')}
        options={NETWORK}
      />
      <SelectField
        pointer={`${base}/security`}
        label="Security"
        value={security}
        options={SECURITY}
      />
      <TextField
        pointer={`${base}/serverName`}
        label="Handshake name"
        value={config['serverName']}
        help="Left empty, the address above is used."
      />

      {/*
        * Both or neither. Reality needs the key and the short id together, and a control that offered
        * one without the other would produce a configuration that validates and cannot connect —
        * which is the shape of failure this whole epic is about.
        */}
      {security === 'reality' ? (
        <>
          <TextField pointer={`${base}/realityPublicKey`} label="Reality key" value={config['realityPublicKey']} />
          <TextField
            pointer={`${base}/realityShortId`}
            label="Reality short id"
            value={config['realityShortId']}
            help="Needed together with the key above."
          />
        </>
      ) : null}

      <Fold summary="Advanced">
        <TextField
          pointer={`${base}/flow`}
          label="Flow"
          value={config['flow']}
          help="Present on flow-controlled accounts only."
        />
        <TextField
          pointer={`${base}/fingerprint`}
          label="Client signature"
          value={config['fingerprint']}
          help="A TLS client to imitate, such as chrome."
        />
        <TextList
          pointer={`${base}/alpn`}
          label="Protocols offered"
          value={config['alpn'] as string[] | undefined}
          rows={2}
        />
        <TextField
          pointer={`${base}/path`}
          label="Path"
          value={config['path']}
          help="Used when this is carried over WebSocket, gRPC or HTTP."
        />
        <TextField
          pointer={`${base}/host`}
          label="Host header"
          value={config['host']}
          help="Only when it differs from the handshake name."
        />
        {/*
          * Asked for as what it is — a parameter the link carried — and never as what it causes. It
          * is marked as a credential because the value is key material rather than a mode name: 1.6
          * KiB of it on the bench board, measured 2026-09-21.
          */}
        <SecretField
          pointer={`${base}/encryption`}
          label="Encryption parameter"
          value={config['encryption']}
          blob
          help="From the link, if it carried one."
        />
      </Fold>
    </>
  );
}

/**
 * Paste a link, and the fields below fill themselves.
 *
 * **Not a `Field`, and it carries no pointer.** A pasted link is not a position in the profile
 * document — it is a thing a person holds that this control takes apart into positions. A pointer
 * stamped here would add a field to the coverage manifest that the schema does not have, which is
 * the mirror image of the collision this epic exists to close.
 *
 * A refusal is printed **in the parser's own words**, never reworded. The refusal's whole value is
 * that it names both halves — which scheme was not accepted, and which ones are — and a paraphrase
 * on the way to the screen keeps the first half and loses the second.
 */
function PasteLink({ index, named }: { index: number; named: boolean }): ReactElement {
  const draft = useDraft();
  const [text, setText] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [filled, setFilled] = useState<string | null>(null);

  const take = (): void => {
    setRefusal(null);
    setFilled(null);
    const result = parseSubscription(text);
    const node = result.nodes[0];

    if (node === undefined) {
      // Verbatim. The parser says which scheme it read and which the catalogue runs; this screen has
      // nothing to add and everything to lose by rewriting it.
      setRefusal(result.failures[0]?.reason ?? 'Nothing here is a link.');
      return;
    }
    if (node.protocol !== 'vless') {
      setRefusal(
        `That link is a ${node.protocol} link. This tunnel is VLESS; add a ${node.protocol} tunnel instead of ` +
          'changing what this one is.',
      );
      return;
    }

    draft.set(`/tunnels/${index}/config`, node.config);
    // The link's own label only takes a name that is not there yet. Overwriting one somebody typed
    // would quietly replace the only word on the list that they chose themselves.
    if (!named && node.label !== null) draft.set(`/tunnels/${index}/name`, node.label);
    setText('');
    setFilled(
      result.nodes.length > 1
        ? `Filled from the first of ${result.nodes.length} links. The rest were ignored — this control fills one tunnel.`
        : 'Filled from the link. Check the fields below before saving.',
    );
  };

  return (
    <div className="paste-link">
      <label>
        <span className="field-label">Paste a link</span>
        <textarea
          rows={2}
          spellCheck={false}
          value={text}
          placeholder="vless://…"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <p className="muted field-help">
        It fills the fields below and is not itself stored.
      </p>
      <div className="row-actions">
        <button type="button" disabled={text.trim() === ''} onClick={take}>
          Fill from link
        </button>
      </div>
      {refusal === null ? null : <p className="note">{refusal}</p>}
      {filled === null ? null : <p className="muted">{filled}</p>}
    </div>
  );
}
