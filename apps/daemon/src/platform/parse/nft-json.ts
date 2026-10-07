/**
 * Narrowing for `nft -j list ruleset`.
 *
 * The one thing this parser exists to make impossible: losing track of a table this
 * project does not own. Measured on the bench board, the live ruleset holds four
 * tables in the `inet` family and only some of them could ever be ours. A proxy core
 * that manages redirection creates its own table, and `flush ruleset` deletes it —
 * silently disabling tunnelling on any restart of the firewall service. So the
 * generated ruleset recreates only owned tables, and `foreignTables` below is how the
 * code can assert that at runtime instead of trusting the generator.
 */

export interface NftTable {
  family: string;
  name: string;
  handle: number | null;
}

export interface NftChain {
  family: string;
  table: string;
  name: string;
  /** `filter`, `nat`, `route`… absent for a regular (non-base) chain. */
  type: string | null;
  hook: string | null;
  priority: number | string | null;
  policy: string | null;
  handle: number | null;
}

export interface NftRuleset {
  tables: NftTable[];
  chains: NftChain[];
  /** Number of rule objects, which is all the ruleset summary needs. */
  ruleCount: number;
  /** The nftables JSON schema version from the document's metainfo. */
  jsonSchemaVersion: number | null;
  nftablesVersion: string | null;
}

export function parseNftRuleset(json: string): NftRuleset {
  const empty: NftRuleset = {
    tables: [],
    chains: [],
    ruleCount: 0,
    jsonSchemaVersion: null,
    nftablesVersion: null,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return empty;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['nftables'])) return empty;

  const result: NftRuleset = { ...empty, tables: [], chains: [] };

  for (const item of parsed['nftables']) {
    if (!isRecord(item)) continue;

    const metainfo = item['metainfo'];
    if (isRecord(metainfo)) {
      result.jsonSchemaVersion = asNumber(metainfo['json_schema_version']);
      result.nftablesVersion = asString(metainfo['version']);
    }

    const table = item['table'];
    if (isRecord(table)) {
      const family = asString(table['family']);
      const name = asString(table['name']);
      if (family !== null && name !== null) {
        result.tables.push({ family, name, handle: asNumber(table['handle']) });
      }
    }

    const chain = item['chain'];
    if (isRecord(chain)) {
      const family = asString(chain['family']);
      const tableName = asString(chain['table']);
      const name = asString(chain['name']);
      if (family !== null && tableName !== null && name !== null) {
        result.chains.push({
          family,
          table: tableName,
          name,
          type: asString(chain['type']),
          hook: asString(chain['hook']),
          priority:
            typeof chain['prio'] === 'number' || typeof chain['prio'] === 'string'
              ? (chain['prio'] as number | string)
              : null,
          policy: asString(chain['policy']),
          handle: asNumber(chain['handle']),
        });
      }
    }

    if (isRecord(item['rule'])) result.ruleCount += 1;
  }

  return result;
}

/**
 * Tables that are not ours. `owned` is the set of `family:name` pairs the generator
 * produced, so this is a comparison against what we intended to write rather than
 * against a hardcoded list of other people's names.
 */
export function foreignTables(ruleset: NftRuleset, owned: Iterable<string>): NftTable[] {
  const ours = new Set(owned);
  return ruleset.tables.filter((t) => !ours.has(`${t.family}:${t.name}`));
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
