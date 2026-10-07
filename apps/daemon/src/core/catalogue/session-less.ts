/**
 * How a tunnel with **no session** is asked whether it is alive — shared by VLESS and the proxy entry.
 *
 * Neither protocol has a handshake state or a keepalive, and there is nothing to ask while it is idle:
 * each connection is dialled on its own, and between connections nothing exists to measure. xray's own
 * health mechanism, Observatory, answers this the same way — a request through the outbound to a
 * `generate_204` responder — which is why this does not add it: it would be new client configuration and
 * a second control channel for no new information.
 *
 * So `core/liveness.ts` reads what is already there first — bytes arriving back through the outbound
 * from the owner's own traffic — and only when it is idle sends a request through the outbound to
 * neutral connectivity checks, decided by majority.
 *
 * The outbound's tag is the tunnel id: every entry's object joins the core configuration under it.
 */

import type { LivenessMethod } from '../liveness.ts';
import type { LivenessSubjectInput } from './index.ts';

export function sessionLessLiveness(subject: LivenessSubjectInput): LivenessMethod {
  return { kind: 'through-outbound', outbound: subject.tunnelId };
}

/**
 * The outbound speaks a proxy protocol to a server — the VLESS server, the proxy, or the local external
 * client, whose configuration holds a VLESS outbound and nothing else (`xrayConfig`: no direct outbound
 * to fall back to). A proxy protocol that cannot reach its far end fails the connection; it has no path
 * of its own around the server it is configured for.
 */
export function sessionLessFailsClosed(): string {
  return (
    'its outbound is a proxy protocol, which fails the connection when its server cannot be reached, so ' +
    'while the tunnel is down its traffic fails and cannot leave another way'
  );
}
