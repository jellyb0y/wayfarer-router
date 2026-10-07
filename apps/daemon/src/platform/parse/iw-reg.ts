/**
 * Parser for `iw reg get`.
 *
 * The regulatory domain decides which channels may be used at what power, and it can
 * change while the device is running because some drivers accept regulatory hints
 * from the surrounding network. So it is read at runtime, never assumed.
 *
 * Two facts about the output, both measured on the bench board, both of which break
 * the obvious parser:
 *
 * 1. There is a `global` block *and* per-phy blocks, and a phy block **overrides** the
 *    global one for that radio. The global block reported `country US: DFS-FCC` while
 *    `phy#1` reported `country 00: DFS-UNSET` — different channel sets and different
 *    power limits. Reading only the first block gives the wrong answer for that radio.
 * 2. **A phy can be absent from the output entirely.** `phy#0` was not listed at all,
 *    even though it exists, is up, and is hosting an access point. Absence means "uses
 *    the global domain", so a lookup must fall back rather than report no domain.
 */

export interface RegRule {
  startMhz: number;
  endMhz: number;
  maxBandwidthMhz: number;
  /** Antenna gain in dBi; `N/A` becomes null. */
  maxAntennaGainDbi: number | null;
  maxEirpDbm: number | null;
  /** Channel availability check time in ms; `N/A` becomes null. */
  dfsCacMs: number | null;
  /** `DFS`, `AUTO-BW`, `NO-OUTDOOR`, `PASSIVE-SCAN`, `NO-OFDM`… verbatim. */
  flags: string[];
}

export interface RegDomain {
  /** `global`, or `phy#1` for a per-radio override. */
  scope: string;
  /** Null when the scope line names a phy that has no phy index (never seen). */
  phy: string | null;
  /** Two-letter code, or `00` for the world domain. */
  country: string;
  /** `DFS-FCC`, `DFS-ETSI`, `DFS-UNSET`… */
  dfsRegion: string | null;
  rules: RegRule[];
}

export interface RegDomains {
  global: RegDomain | null;
  /** Keyed by phy name, e.g. `phy1`. A phy absent here uses the global domain. */
  perPhy: Record<string, RegDomain>;
}

const COUNTRY = /^country\s+(\S+?):\s*(\S+)?\s*$/;

export function parseIwRegGet(output: string): RegDomains {
  const result: RegDomains = { global: null, perPhy: {} };

  let scope = 'global';
  let current: RegDomain | null = null;

  const commit = (): void => {
    if (!current) return;
    if (current.phy) result.perPhy[current.phy] = current;
    else result.global = current;
    current = null;
  };

  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;

    if (line === 'global') {
      commit();
      scope = 'global';
      continue;
    }
    const phy = /^phy#(\S+)$/.exec(line);
    if (phy) {
      commit();
      scope = `phy#${phy[1]}`;
      continue;
    }

    const country = COUNTRY.exec(line);
    if (country) {
      commit();
      current = {
        scope,
        phy: scope.startsWith('phy#') ? `phy${scope.slice('phy#'.length)}` : null,
        country: country[1]!,
        dfsRegion: country[2] ?? null,
        rules: [],
      };
      continue;
    }

    const rule = parseRule(line);
    if (rule && current) current.rules.push(rule);
  }
  commit();

  return result;
}

/**
 * The rule the radio at `phy` must obey: its own domain when it published one,
 * otherwise the global domain. Returns null when neither exists, which is a real
 * state on a kernel with no regulatory database loaded and must be surfaced rather
 * than replaced with a guess.
 */
export function domainForPhy(domains: RegDomains, phy: string): RegDomain | null {
  return domains.perPhy[phy] ?? domains.global ?? null;
}

/** `(5250 - 5350 @ 80), (N/A, 24), (0 ms), DFS, AUTO-BW` */
function parseRule(line: string): RegRule | null {
  const head = /^\((\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*@\s*(\d+(?:\.\d+)?)\)\s*,\s*(.*)$/.exec(line);
  if (!head) return null;

  const rest = head[4]!;
  const groups = [...rest.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!.trim());
  const power = groups[0]?.split(',').map((p) => p.trim()) ?? [];
  const cac = groups[1];

  // Flags are whatever is left outside parentheses, comma separated.
  const flags = rest
    .replace(/\([^)]*\)/g, '')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  return {
    startMhz: Number.parseFloat(head[1]!),
    endMhz: Number.parseFloat(head[2]!),
    maxBandwidthMhz: Number.parseFloat(head[3]!),
    maxAntennaGainDbi: naOrNumber(power[0]),
    maxEirpDbm: naOrNumber(power[1]),
    dfsCacMs: naOrNumber(cac),
    flags,
  };
}

function naOrNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '' || /^N\/A$/i.test(trimmed)) return null;
  const match = /-?\d+(\.\d+)?/.exec(trimmed);
  if (!match) return null;
  const n = Number.parseFloat(match[0]);
  return Number.isFinite(n) ? n : null;
}
