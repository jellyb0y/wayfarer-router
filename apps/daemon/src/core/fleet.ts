/**
 * An aggregate view across devices, with no central controller.
 *
 * ## What this is not
 *
 * There is no server, no enrolment, no device that is authoritative over another and nothing that can
 * change a peer. Each device holds **its own** list of peers, and two devices holding different lists
 * are both correct — the view is one operator's convenience, not a topology.
 *
 * That constraint is what keeps the design honest. The moment one device can reconfigure another, the
 * whole safety argument of this project has to be rewritten: the confirmation window protects the
 * operator of the device being changed, and a change arriving from elsewhere has no such operator
 * watching. So the fan-out is **read-only**, uses a read-scoped token the peer itself issued, and the
 * aggregate view is built in the browser's own device from answers, not from a shared database.
 *
 * ## Three-valued, because "did not answer" is not "is down"
 *
 * A peer that cannot be reached is *unknown*, and it is reported as unknown rather than as a device in
 * trouble. The commonest reason a peer does not answer is that the network between here and there is
 * the thing being reconfigured — which is exactly when a screen saying "three of your devices are down"
 * would send somebody to fix four problems instead of one.
 *
 * ## It must never hold up the local view
 *
 * Every request is bounded and they run together, so a peer on a dead link costs one timeout for the
 * whole page rather than one each. The local device's own row is filled in without any network at all,
 * so an aggregate view of unreachable peers still tells the operator about the device in front of them.
 */

export interface PeerTarget {
  id: string;
  label: string;
  baseUrl: string;
  token: string | null;
}

export interface PeerSummary {
  id: string;
  label: string;
  baseUrl: string;
  /**
   * `self` for this device, `answered` for a peer that replied, `refused` when it replied with an
   * error — most often a credential it will not accept — and `unreachable` when nothing came back.
   *
   * `refused` and `unreachable` are separated on purpose: one is a device that is working and does not
   * trust us, the other is a device we cannot see. They call for entirely different actions and a
   * single "error" would hide which.
   */
  state: 'self' | 'answered' | 'refused' | 'unreachable';
  /** Filled in only when the peer answered. */
  deviceId?: string;
  deviceName?: string;
  version?: string;
  uptimeSeconds?: number;
  activeProfile?: string | null;
  /** Why it is not `answered`, in the peer's own words where there are any. */
  detail?: string;
}

export interface FleetDeps {
  /** Replaced in tests. Returns the parsed body and the status, or throws when nothing came back. */
  fetchJson: (url: string, token: string | null, timeoutMs: number) => Promise<{ status: number; body: unknown }>;
  timeoutMs?: number;
}

/**
 * Asks each peer for its identity and state, all at once.
 *
 * Never throws: a fan-out that can fail takes the page with it, and the page is the only way the
 * operator can see the device they are actually standing next to.
 */
export async function collectFleet(
  self: { deviceId: string; deviceName: string; version: string; uptimeSeconds: number; activeProfile: string | null },
  peers: PeerTarget[],
  deps: FleetDeps,
): Promise<PeerSummary[]> {
  const timeoutMs = deps.timeoutMs ?? 4000;

  const selfRow: PeerSummary = {
    id: self.deviceId,
    label: self.deviceName,
    baseUrl: '',
    state: 'self',
    deviceId: self.deviceId,
    deviceName: self.deviceName,
    version: self.version,
    uptimeSeconds: self.uptimeSeconds,
    activeProfile: self.activeProfile,
  };

  const answers = await Promise.all(
    peers.map(async (peer): Promise<PeerSummary> => {
      const base: Pick<PeerSummary, 'id' | 'label' | 'baseUrl'> = {
        id: peer.id,
        label: peer.label,
        baseUrl: peer.baseUrl,
      };

      if (peer.token === null) {
        return {
          ...base,
          state: 'refused',
          detail: 'no token is stored for this peer, so it cannot be asked',
        };
      }

      try {
        const result = await deps.fetchJson(`${peer.baseUrl.replace(/\/+$/, '')}/api/system`, peer.token, timeoutMs);
        if (result.status === 401 || result.status === 403) {
          return {
            ...base,
            state: 'refused',
            detail: `the peer rejected the stored token (${result.status}). It is working; it does not accept this credential.`,
          };
        }
        if (result.status !== 200) {
          return { ...base, state: 'refused', detail: `the peer answered ${result.status}` };
        }
        // Read field by field rather than spread: a peer may be a different version of this software,
        // and copying whatever it sent into our own shape is how a field we stopped supporting comes
        // back as a rendered value nobody can explain.
        const body = (result.body ?? {}) as Record<string, unknown>;
        return {
          ...base,
          state: 'answered' as const,
          ...(typeof body['deviceId'] === 'string' ? { deviceId: body['deviceId'] } : {}),
          ...(typeof body['deviceName'] === 'string' ? { deviceName: body['deviceName'] } : {}),
          ...(typeof body['version'] === 'string' ? { version: body['version'] } : {}),
          ...(typeof body['uptimeSeconds'] === 'number' ? { uptimeSeconds: body['uptimeSeconds'] } : {}),
          activeProfile: typeof body['activeProfile'] === 'string' ? body['activeProfile'] : null,
        };
      } catch (error) {
        return {
          ...base,
          state: 'unreachable',
          detail: `nothing came back within ${Math.round(timeoutMs / 1000)}s: ${String(error)}`,
        };
      }
    }),
  );

  return [selfRow, ...answers];
}

/**
 * Peers that claim the same identity as this device, or as each other.
 *
 * Worth reporting because it has one likely cause and it is not a network fault: **a card was cloned.**
 * Two installations flashed from one image share everything this device did not generate itself, and an
 * aggregate view is exactly where that first becomes visible — as two rows that are somehow one device.
 *
 * Reported rather than resolved. Which of them should change its identity is not a question this code
 * can answer, and changing one automatically would silently rewrite the identity of a device somebody
 * else is looking at.
 */
export function duplicateIdentities(rows: PeerSummary[]): string[] {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const id = row.deviceId;
    if (id === undefined || id === '') continue;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}
