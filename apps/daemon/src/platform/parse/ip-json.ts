/**
 * Narrowing for `ip -j` output.
 *
 * iproute2 emits JSON for everything needed here (6.15.0 on the bench board), which
 * removes a class of text-parsing bugs. What remains is that the JSON is *not* a
 * contract: fields appear and disappear between versions and between link types, and
 * `ip` will happily emit a field we have never seen. So this layer copies out what it
 * understands, keeps the rest, and never asserts on a field's presence.
 *
 * Every function tolerates an unparsable or empty document by returning an empty
 * list. The caller is a status view; it must degrade rather than throw.
 */

export interface NetLink {
  ifindex: number;
  name: string;
  /** Kernel flags: `UP`, `LOWER_UP`, `NO-CARRIER`, `BROADCAST`… */
  flags: string[];
  mtu: number | null;
  /** `UP`, `DOWN`, `DORMANT`, `UNKNOWN`. Not the same thing as the UP flag. */
  operstate: string | null;
  /** `ether`, `loopback`, `none` (tun devices report `none`). */
  linkType: string | null;
  mac: string | null;
  /** Alternative names, which is how a renamed interface stays findable. */
  altNames: string[];
  /** Kind for virtual links (`tun`, `bridge`, `vlan`…), when `ip` reports it. */
  kind: string | null;
}

export interface NetAddress {
  ifindex: number;
  name: string;
  family: 'inet' | 'inet6' | string;
  address: string;
  prefixLength: number;
  scope: string | null;
  /** True for an address the kernel considers temporary or deprecated. */
  dynamic: boolean;
  /** `permanent` lifetimes are the 32-bit maximum, kept as reported. */
  validLifeTime: number | null;
}

export interface NetRoute {
  /** `default` or a CIDR, exactly as `ip` prints it. */
  destination: string;
  /**
   * Address family of this route.
   *
   * `ip -j route show` does not print one: which table was read is knowledge the *caller* has,
   * because it chose the command. So it is passed in rather than inferred from the text — the
   * earlier version filtered `destination === 'default'` and then asked whether that same string
   * contained a colon, which is a condition that can never be true and quietly made the family
   * argument do nothing.
   */
  family: 'inet' | 'inet6';
  gateway: string | null;
  device: string | null;
  /** `dhcp`, `kernel`, `static`, `boot`… where the route came from. */
  protocol: string | null;
  scope: string | null;
  preferredSource: string | null;
  metric: number | null;
  table: string | null;
}

export function parseIpLinks(json: string): NetLink[] {
  return asArray(json).flatMap((entry) => {
    const ifindex = asNumber(entry['ifindex']);
    const name = asString(entry['ifname']);
    if (ifindex === null || name === null) return [];
    const linkinfo = isRecord(entry['linkinfo']) ? entry['linkinfo'] : undefined;
    return [
      {
        ifindex,
        name,
        flags: asStringArray(entry['flags']),
        mtu: asNumber(entry['mtu']),
        operstate: asString(entry['operstate']),
        linkType: asString(entry['link_type']),
        mac: asString(entry['address']),
        altNames: asStringArray(entry['altnames']),
        kind: linkinfo ? asString(linkinfo['info_kind']) : null,
      },
    ];
  });
}

export function parseIpAddresses(json: string): NetAddress[] {
  const out: NetAddress[] = [];
  for (const entry of asArray(json)) {
    const ifindex = asNumber(entry['ifindex']);
    const name = asString(entry['ifname']);
    if (ifindex === null || name === null) continue;
    const infos = Array.isArray(entry['addr_info']) ? entry['addr_info'] : [];
    for (const raw of infos) {
      if (!isRecord(raw)) continue;
      const address = asString(raw['local']);
      const prefixLength = asNumber(raw['prefixlen']);
      if (address === null || prefixLength === null) continue;
      out.push({
        ifindex,
        name,
        family: asString(raw['family']) ?? 'unknown',
        address,
        prefixLength,
        scope: asString(raw['scope']),
        dynamic: raw['dynamic'] === true || raw['temporary'] === true,
        validLifeTime: asNumber(raw['valid_life_time']),
      });
    }
  }
  return out;
}

/**
 * Whether a link has a carrier, as `ip -j link` reports it — `null` when the record cannot say.
 *
 * **`ip` prints `operstate` in upper case** (`"UP"`, `"DOWN"`, `"DORMANT"`, `"UNKNOWN"`), exactly as
 * the fixture captured from the bench board shows. Two readers compared it with lower-case `'up'` and
 * `'unknown'`, so on the real board every link read as having no carrier: the window's uplink check
 * concluded "neither carrier nor address" about `wfwan0` while it was `UP, LOWER_UP` holding
 * `192.168.77.8/24`, and reverted healthy changes at 45 s. Their tests passed because the stand-in
 * snapshot was written in lower case — a stand-in answering in a shape the real tool never produces.
 *
 * The kernel's own carrier bit comes first. `LOWER_UP` is `IFF_LOWER_UP`, set exactly when the driver
 * reports carrier; `NO-CARRIER` is what `ip` prints for an interface that is administratively up with
 * the carrier off. Only when neither flag is present does `operstate` decide, compared without regard
 * to case. `UNKNOWN` with no flag either way is a driver that does not report, which is `null` — not
 * `false` — so it can never be grounds for anything.
 */
export function linkCarrier(link: Pick<NetLink, 'flags' | 'operstate'>): boolean | null {
  const flags = new Set((link.flags ?? []).map((flag) => flag.toUpperCase()));
  if (flags.has('LOWER_UP')) return true;
  if (flags.has('NO-CARRIER')) return false;
  switch ((link.operstate ?? '').toUpperCase()) {
    case 'UP':
      return true;
    case 'DOWN':
    case 'LOWERLAYERDOWN':
    case 'NOTPRESENT':
    case 'DORMANT':
      return false;
    default:
      return null;
  }
}

/**
 * @param family which table this output came from. `ip -j route show` is the IPv4 table and
 * `ip -6 -j route show` is the IPv6 one; the command decides, so the caller states it.
 */
export function parseIpRoutes(json: string, family: 'inet' | 'inet6' = 'inet'): NetRoute[] {
  return asArray(json).flatMap((entry) => {
    const destination = asString(entry['dst']);
    if (destination === null) return [];
    return [
      {
        destination,
        family,
        gateway: asString(entry['gateway']),
        device: asString(entry['dev']),
        protocol: asString(entry['protocol']),
        scope: asString(entry['scope']),
        preferredSource: asString(entry['prefsrc']),
        metric: asNumber(entry['metric']),
        table: asString(entry['table']),
      },
    ];
  });
}

/**
 * The default route **of one family**, chosen by lowest metric. A missing metric sorts as 0, which
 * is what the kernel does with it.
 *
 * The family comes from the route's own `family`, which the parser was told by the caller that ran
 * the command. An earlier version filtered `destination === 'default'` and then asked whether that
 * same string contained a colon — a condition that can never be true, so the argument did nothing
 * and an IPv6 default route was returned for both families. A dormant wrong answer is harder to
 * find than a missing function, which is why the family is now carried rather than guessed.
 *
 * Used for reporting only. Nothing about where the management interface listens is
 * derived from this: a bind set computed from "not the default route" changes
 * silently when the default route moves or disappears, and the failure it produces
 * is publishing the management interface on the uplink.
 */
export function defaultRoute(routes: NetRoute[], family: 'inet' | 'inet6' = 'inet'): NetRoute | null {
  const candidates = routes.filter((route) => route.destination === 'default' && route.family === family);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, route) => ((route.metric ?? 0) < (best.metric ?? 0) ? route : best));
}

function asArray(json: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * `ip -j route get <address>` — one entry describing how this device would send to that address.
 *
 * The answer that matters is `dev`. `ip route get` resolves the whole decision, policy rules
 * included, which is why it is the right question to ask: reading the main table would miss exactly
 * the case this exists to catch, because a tunnel captures traffic with rules rather than by editing
 * the table everyone reads.
 */
export function parseRouteGet(json: string): { device: string | null; source: string | null } | null {
  const first = asArray(json)[0];
  if (first === undefined) return null;
  return { device: asString(first['dev']), source: asString(first['prefsrc']) };
}
