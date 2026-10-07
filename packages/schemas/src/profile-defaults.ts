/**
 * The document a profile starts as, and the one the device falls back to.
 *
 * Both are here rather than in the daemon because they are *documents*, and a document is the same
 * thing wherever it is read: the interface builds one when someone presses New, the daemon writes
 * one on first boot, and a test constructs one without a device in sight.
 *
 * The defining property of `emptyProfile()` is what it leaves out. **No uplink**, because every
 * implicit default here is wrong for somebody: a board with no dongle can only put the access point
 * on its built-in radio, a board with a dongle usually wants the opposite, and guessing produces a
 * device whose behaviour cannot be predicted from its configuration. **No access point**, because a
 * board may have no radio at all and a profile that is only legal on some hardware cannot be
 * shared. **No tunnel**, and therefore **no kill-switch**, because a device with nothing configured
 * yet and a kill-switch on looks broken.
 */

import { PROFILE_SCHEMA_VERSION, type HardwareBinding, type ProfileDocument } from './profile.ts';

export interface EmptyProfileOptions {
  name?: string;
  description?: string;
  /** Injected so a generated document is reproducible in a test. */
  now?: () => string;
  /**
   * The LAN the device offers. A default exists because a device must hand out addresses to be
   * reachable at all, and `10.44.0.0/24` is chosen to be unusual enough that it rarely collides
   * with a network the device is plugged into — which is a real failure, not a tidiness concern:
   * an uplink on the same subnet as the LAN makes the return path ambiguous.
   */
  cidr?: string;
}

export function emptyProfile(options: EmptyProfileOptions = {}): ProfileDocument {
  const now = options.now ?? (() => new Date().toISOString());
  const at = now();

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    meta: {
      name: options.name ?? 'New profile',
      ...(options.description !== undefined ? { description: options.description } : {}),
      createdAt: at,
      updatedAt: at,
    },
    uplinks: [],
    accessPoint: null,
    network: {
      cidr: options.cidr ?? '10.44.0.1/24',
      dhcp: { enabled: true, from: '10.44.0.100', to: '10.44.0.200', leaseHours: 12 },
    },
    tunnels: [],
    // Empty, like tunnels and uplinks: a new profile subscribes to nothing.
    subscriptions: [],
    policy: {
      priority: [],
      excluded: [],
      sticky: true,
      probes: {
        count: 4,
        maxFails: 2,
        maxLatencyMs: 500,
        maxJitterMs: 250,
        maxLossPercent: 34,
        failStreak: 2,
        intervalSeconds: 30,
        // Two unrelated endpoints, so one third party going down is a bad sample rather than the
        // watchdog's verdict on every tunnel at once. Both are the tiny 204 responders that exist for
        // this purpose, which keeps a probe every thirty seconds negligible.
        endpoints: ['http://cp.cloudflare.com/generate_204', 'http://connectivitycheck.gstatic.com/generate_204'],
      },
      onAllDown: 'block',
    },
    routing: {
      // The protect anchor is present from the first moment a profile exists, and it is first.
      // Private address space overlaps heavily — corporate networks routinely occupy large parts of
      // 10/8 and 192.168/16, which is also where the management network lives — so a tunnel rule
      // added later above this anchor would take the operator's own traffic with it. Starting with
      // the anchor already in place means the dangerous arrangement has to be created deliberately.
      rules: [{ kind: 'protect-own-networks' }, { kind: 'tunnel-resources' }],
      ruleSets: [],
    },
    dns: { direct: 'auto', overTunnel: '1.1.1.1', strategy: 'ipv4_only', logQueries: false },
    firewall: { killSwitch: false, ipv6: 'block', ntpBypass: true, blockedEndpoints: [] },
    services: {
      clashApi: { enabled: true, bind: '127.0.0.1:9090' },
      // On by default: reaching the panel from a laptop on the same network as the device is what an
      // owner expects. The switch exists because that network is a hotel's wireless when they travel.
      management: { onUplinkNetwork: true },
    },
  };
}

/**
 * The built-in recovery configuration: access point, addresses, no tunnel and no kill-switch.
 *
 * Reached after repeated apply failures, or when a start-up check finds no working management path.
 * It deliberately depends on as little as possible — no uplink, so nothing can be waited on; no
 * tunnel, so the proxy core is irrelevant; no kill-switch, so nothing is rejected — because the one
 * job of this document is to make the device reachable again.
 *
 * It takes the radio binding as an argument rather than embedding one. A recovery profile that
 * names hardware would be a constant describing somebody's board, and on a device whose radio does
 * not match it would recover into an access point that cannot start, which is worse than no
 * recovery profile at all.
 */
export function recoveryProfile(options: {
  bind: HardwareBinding;
  ssid: string;
  passphrase: string;
  country: string;
  channel: number;
  band: '2.4GHz' | '5GHz' | '6GHz';
  now?: () => string;
}): ProfileDocument {
  const base = emptyProfile({
    name: 'Recovery',
    description: 'Access point and addresses only. No uplink, no tunnel, no kill-switch.',
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    ...base,
    accessPoint: {
      bind: options.bind,
      // 20 MHz: the width most likely to work on an unknown radio in an unknown regulatory domain,
      // and this document's job is to come up, not to be fast.
      radio: { band: options.band, channel: options.channel, width: 20, country: options.country, hidden: false },
      ssid: options.ssid,
      passphrase: options.passphrase,
      acceptChannelFollowsUplink: false,
    },
    services: {
      clashApi: { enabled: false, bind: '127.0.0.1:9090' },
      // Recovery keeps the uplink surface too: the operator recovering a device may be reaching it from a
      // laptop on the same network, and a recovery profile that narrows how the device can be reached is
      // working against its own purpose.
      management: { onUplinkNetwork: true },
    },
  };
}
