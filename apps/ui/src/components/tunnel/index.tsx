/**
 * One editor per catalogue entry, **joined to the catalogue by the compiler.**
 *
 * `TUNNEL_CONFIGS` is a total map over the protocol keys and so is this. A catalogue entry added in
 * `@wayfarer/schemas` without an editor here does not compile — the same mechanism the schema uses to
 * keep its own two halves from being half-added, applied to the third half that lives in the browser.
 * Epic F appends Shadowsocks and WireGuard by adding a key in both places; nothing switches on a
 * protocol name anywhere else in this directory.
 *
 * There is no generic renderer behind this and no fallback. A protocol with no designed screen is a
 * compile error rather than a form somebody has to read a manual to fill, which is the trade this
 * epic made deliberately: zero code per protocol did not remove the per-protocol work, it moved that
 * work into the owner's configuration, where nothing typed it and nothing tested it.
 */
import type { ReactElement } from 'react';
import { TUNNEL_PROTOCOL_TITLES, type TunnelProtocol } from '@wayfarer/schemas';
import { t } from '../../lib/i18n.ts';
import type { Tunnel } from './common.tsx';
import { OpenVpnEditor } from './openvpn.tsx';
import { CloakOpenVpnEditor } from './cloak.tsx';
import { VlessEditor } from './vless.tsx';
import { ProxyEditor } from './proxy.tsx';

export { TunnelCommonFields, type Tunnel } from './common.tsx';

/**
 * The catalogue entries in the owner's words, **read from the catalogue and written down nowhere.**
 *
 * Never the name of the program that runs one: a catalogue named after what we start is a catalogue
 * named from our side of the product, and what an owner holds is an `.ovpn` file, an `.ovpn` file
 * plus entry points, or a link.
 *
 * It lives here rather than on a screen because there were two of it. `Tunnels.tsx` read the
 * catalogue and `Routing.tsx` switched on three protocol names inline, with the same comment above
 * it explaining why it must not. A fourth entry added in Epic F would have rendered on Routing as
 * *unknown* for a protocol the device is actively carrying traffic over — and it compiles, so
 * nothing announces it. `TUNNEL_PROTOCOL_TITLES` is a total map over `TunnelProtocol`, so the
 * omission that matters — a catalogue entry with no title at all — is already a compile error in the
 * schema package, and reading it here is what extends that to the screens.
 *
 * The fallback is for a *document*, not for a catalogue gap: storage refuses a profile naming
 * anything outside the catalogue, so a protocol reaching this is one that got past that refusal, and
 * the honest word for it is the one a person can act on.
 */
export function protocolTitle(protocol: unknown): string {
  if (typeof protocol === 'string' && Object.hasOwn(TUNNEL_PROTOCOL_TITLES, protocol)) {
    return TUNNEL_PROTOCOL_TITLES[protocol as TunnelProtocol];
  }
  return t('common.unknown');
}

type Editor = (props: { index: number; tunnel: Tunnel }) => ReactElement;

const EDITORS = {
  openvpn: OpenVpnEditor,
  'cloak-openvpn': CloakOpenVpnEditor,
  vless: VlessEditor,
  proxy: ProxyEditor,
} as const satisfies Record<TunnelProtocol, Editor>;

/**
 * A new tunnel of each kind, with the fields its entry cannot start without.
 *
 * Also a total map, for the same reason: a catalogue entry that can be chosen from the list and
 * produces a shape nobody wrote is a blank form with an invisible requirement in it.
 */
const BLANKS = {
  openvpn: () => ({ profile: undefined }),
  'cloak-openvpn': () => ({ profile: undefined, entryPoints: [] }),
  vless: () => ({ server: '', port: 443, network: 'tcp', security: 'tls' }),
  // 1080 because a new proxy starts as SOCKS, and 1080 is the port a SOCKS proxy is reached on far
  // more often than any other. A blank port is a field somebody has to look up to fill.
  proxy: () => ({ type: 'socks', server: '', port: 1080 }),
} as const satisfies Record<TunnelProtocol, () => Record<string, unknown>>;

export function blankTunnel(protocol: TunnelProtocol, existing: readonly Tunnel[]): Tunnel {
  // The id has to satisfy the identifier rules and has to be unique among tunnels, so it is counted
  // past what is already there rather than taken from the list's length — removing the third of three
  // and adding one would otherwise reuse an id a routing rule may still name.
  const taken = new Set(existing.map((tunnel) => String(tunnel['id'])));
  let counter = existing.length + 1;
  while (taken.has(`tunnel-${counter}`)) counter += 1;

  return {
    id: `tunnel-${counter}`,
    name: `${TUNNEL_PROTOCOL_TITLES[protocol]} ${counter}`,
    role: 'alternative',
    enabled: true,
    onUnavailable: 'block',
    protocol,
    config: BLANKS[protocol](),
  };
}

/** The designed screen for whatever this tunnel is. */
export function TunnelEditor({ index, tunnel }: { index: number; tunnel: Tunnel }): ReactElement | null {
  const protocol = tunnel['protocol'];
  if (typeof protocol !== 'string' || !Object.hasOwn(EDITORS, protocol)) {
    /*
     * A stored tunnel naming something outside the catalogue. Storage refuses these, so reaching this
     * means a document got past that — and drawing nothing would report a tunnel with no settings,
     * which is the reading that costs the most: somebody would fill in the fields above and save a
     * tunnel that still cannot run.
     */
    return (
      <p className="note">
        This tunnel names a protocol this device does not run: {String(protocol)}. It cannot be edited
        here, and nothing on this screen will make it work. It runs {Object.values(TUNNEL_PROTOCOL_TITLES).join(', ')}.
      </p>
    );
  }
  const Chosen = EDITORS[protocol as TunnelProtocol];
  return <Chosen index={index} tunnel={tunnel} />;
}
