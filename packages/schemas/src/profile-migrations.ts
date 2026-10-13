/**
 * Profile document migrations.
 *
 * `schemaVersion` lives inside the document, not only in the database, because a document outlives
 * the device it was written on: an export taken today should still import in a year, onto a build
 * that has moved on. Each step is a pure function `(document) → document`, applied in sequence, and
 * each one gets a checked-in fixture of a document at its *input* version so the step is exercised
 * against a shape somebody actually had rather than one reconstructed from the code that reads it.
 *
 * Rules for adding a step: append, never edit a step that has shipped, and never make a step depend
 * on anything outside the document. A migration that reads the hardware is a migration that
 * produces a different result on the device that wrote the profile and the device importing it,
 * which is the one thing the whole-document model exists to avoid.
 */

import { migrateToCatalogue } from './migrate-to-catalogue.ts';
import { PROFILE_SCHEMA_VERSION } from './profile.ts';
import { isRecord } from './secrets.ts';

export interface ProfileMigration {
  /** The version this step upgrades *from*; it produces `from + 1`. */
  from: number;
  name: string;
  migrate(document: Record<string, unknown>): Record<string, unknown>;
}

export const PROFILE_MIGRATIONS: ProfileMigration[] = [
  {
    from: 1,
    name: 'probe endpoints, loss threshold and interval',
    /**
     * The health watchdog needed three fields the probe configuration did not have: what to fetch,
     * how much loss is too much, and how often to look.
     *
     * **Found by a running device, not by a test.** The fields were added to the schema with defaults,
     * which made them present on every *new* profile and absent on every existing one — and a document
     * stored before the change is then no longer valid against the schema that reads it. On the bench
     * board the consequence was a watchdog throwing
     * `TypeError: Cannot read properties of undefined (reading 'length')` on every round, once every
     * thirty seconds, for as long as nobody looked. The loop survived it by design and reported it, which
     * is the only reason it was visible at all.
     *
     * The lesson is the one this machinery was built for and had never been used for: **a default on a
     * required field is not a migration.** It fills the gap for documents written afterwards and does
     * nothing for the ones already on devices, which are exactly the documents an update meets.
     *
     * Values match `profile-defaults.ts`. They are written out here rather than imported because a
     * migration must produce the same result in a year, when the defaults may have moved on: a step that
     * followed the current defaults would rewrite old documents differently depending on when it ran.
     */
    migrate(document) {
      const policy = isRecord(document['policy']) ? { ...document['policy'] } : {};
      const probes = isRecord(policy['probes']) ? { ...policy['probes'] } : {};

      if (probes['maxLossPercent'] === undefined) probes['maxLossPercent'] = 34;
      if (probes['intervalSeconds'] === undefined) probes['intervalSeconds'] = 30;
      if (probes['endpoints'] === undefined) {
        probes['endpoints'] = [
          'http://cp.cloudflare.com/generate_204',
          'http://connectivitycheck.gstatic.com/generate_204',
        ];
      }

      policy['probes'] = probes;
      return { ...document, policy };
    },
  },
  {
    from: 2,
    name: 'blocked endpoints keep their suffix meaning',
    /**
     * The generated block rule changed from `domain_suffix` to `domain`, and that narrowed what every
     * existing entry covered.
     *
     * The exact-match change was right: the core's suffix match is a literal string suffix, so blocking
     * `example.com` as a suffix also blocked `notexample.com` — a trap this repository documents for the
     * `domain` rule kind and had committed here. What was missing was **carrying the old meaning forward.**
     *
     * Silently narrowing a *blocking* rule is a security regression. Somebody entered
     * `whatismyipaddress.com` believing subdomains were covered, and after an upgrade they are not, with
     * nothing telling them. The entry still exists, still looks right, and covers less than it did — no
     * error, no warning, and a reader with no reason to look.
     *
     * So each existing entry becomes **both**: the exact name it now matches, and an explicit
     * `domainSuffix` routing rule with a `block` action carrying what it used to cover. The suffix
     * behaviour is still available and is now *stated* rather than implied by which generator ran.
     *
     * The rule is **appended**, not prepended. A block by name cannot take the management network with it,
     * but the habit of never putting a rule above the protect anchor matters more than this one case.
     *
     * Literals are written out rather than imported, as every step here must be: this must produce the
     * same result in a year, when `CORE_TAGS.block` may be spelled differently.
     */
    migrate(document: Record<string, unknown>): Record<string, unknown> {
      const firewall = isRecord(document['firewall']) ? document['firewall'] : {};
      const blocked = Array.isArray(firewall['blockedEndpoints']) ? firewall['blockedEndpoints'] : [];

      const suffixes: string[] = [];
      for (const entry of blocked) {
        if (!isRecord(entry)) continue;
        const domain = entry['domain'];
        if (typeof domain === 'string' && domain !== '') suffixes.push(domain);
      }

      if (suffixes.length === 0) return document;

      const routing = isRecord(document['routing']) ? document['routing'] : {};
      const rules = Array.isArray(routing['rules']) ? [...routing['rules']] : [];
      rules.push({ kind: 'domainSuffix', suffixes: [...new Set(suffixes)], action: { outbound: 'block' } });

      return { ...document, routing: { ...routing, rules } };
    },
  },
  {
    from: 3,
    name: 'where the management surface answers',
    /**
     * `services.management` decides whether the control panel answers on the network the device is a client
     * of, and it defaults to on.
     *
     * A default in the schema is present on every *new* profile and absent from every stored one, which this
     * repository has already paid for once: the watchdog threw every thirty seconds against a document that
     * predated its probe fields. So the field is added here rather than relied on.
     *
     * `true` is the right value for an existing profile as well as a new one. It is what the owner asked for,
     * and an upgrade that silently narrowed how a device can be reached would be the same class of surprise
     * as the blocked-endpoint narrowing in the step before this one — except that this one would strand
     * somebody whose only route to the panel was the network they are on.
     */
    migrate(document: Record<string, unknown>): Record<string, unknown> {
      const services = isRecord(document['services']) ? { ...document['services'] } : {};
      if (isRecord(services['management'])) return document;
      services['management'] = { onUplinkNetwork: true };
      return { ...document, services };
    },
  },
  {
    from: 4,
    name: 'what a tunnel does when it is unavailable',
    /**
     * `onUnavailable` decides whether traffic assigned to a tunnel is **blocked** or allowed to take the
     * ordinary route when that tunnel cannot carry it. Existing documents have no such field.
     *
     * Every migrated tunnel gets `block`, which is the schema default and the safe answer, but writing it
     * in explicitly matters for a reason the default alone does not cover: **this changes the behaviour of
     * documents that already exist.** Before the field, a rule pointing at a destination tunnel produced a
     * connection error when the tunnel was down; afterwards that traffic is refused by a selector pointed
     * at `block`. For traffic that was assigned to a tunnel deliberately, refusing is what was always
     * meant — but it is a change, and an operator reading the diff should see the field appear with a
     * value rather than have it inferred.
     *
     * The narrower alternative — migrating to `fall-through` so nothing changes — was rejected. It would
     * preserve behaviour by preserving a leak: traffic the operator sent through a tunnel would quietly go
     * direct the moment the tunnel failed, which is the outcome the field exists to prevent. A migration
     * should carry intent forward, and the intent of assigning traffic to a tunnel is that it goes there.
     */
    migrate(document) {
      const tunnels = document['tunnels'];
      if (Array.isArray(tunnels)) {
        for (const tunnel of tunnels) {
          if (tunnel !== null && typeof tunnel === 'object' && !('onUnavailable' in tunnel)) {
            (tunnel as Record<string, unknown>)['onUnavailable'] = 'block';
          }
        }
      }
      return document;
    },
  },
  {
    from: 5,
    name: 'client name logging is a choice, not a default',
    /**
     * `dns.logQueries` records every name each client looks up, with the address that asked.
     *
     * Migrated to **false**, which is both the schema default and the only defensible answer: that list is
     * a record of what the people on a network were doing, and a device that starts keeping it because its
     * schema gained a field would be keeping it for people who never chose this device. A migration that
     * quietly switched on data collection would be the worst kind of silent change.
     */
    migrate(document) {
      const dns = document['dns'];
      if (dns !== null && typeof dns === 'object' && !('logQueries' in dns)) {
        (dns as Record<string, unknown>)['logQueries'] = false;
      }
      return document;
    },
  },
  {
    from: 6,
    name: 'every tunnel becomes a catalogue entry',
    /**
     * The opaque `config` record and the separate `transports` list are replaced by a typed
     * configuration per catalogue entry, and anything outside the catalogue is refused.
     *
     * The work is in `migrate-to-catalogue.ts` rather than inline because it is the only step with
     * translations in it, and because it is the last place in this repository that knows what the
     * old shape meant. It throws `ProfileCatalogueError` when a tunnel cannot be brought forward —
     * see `migrateProfile` for what that leaves behind, which is nothing.
     */
    migrate: migrateToCatalogue,
  },
  {
    from: 7,
    name: 'a tunnel is asked whether it is alive, not a server behind it',
    /**
     * `tunnels[].probe` is removed, and nothing replaces it in the document.
     *
     * Measured on the bench board, 2026-09-24: `partner` carried `probe: { endpoints:
     * ["http://172.30.0.212/"] }`, one of its own resources, because the field's documentation advised
     * giving a tunnel "something that exists behind it". That server stopped answering on port 80 while
     * the tunnel stayed healthy, and the guard blocked every destination behind it. Liveness is now asked
     * of the tunnel's protocol by its catalogue entry, and the field has no meaning left to carry.
     *
     * **Dropped, not translated.** There is nothing to translate it into: the whole point is that the
     * owner no longer tells the device what to measure. Carrying the URL forward anywhere — a note, an
     * unused field — would keep alive the one input that caused the outage. The step's name is in the
     * migration report, so the removal is visible to whoever reads it.
     *
     * Only the key is removed; every other field of the tunnel, `resources` included, is untouched.
     */
    migrate(document) {
      const tunnels = document['tunnels'];
      if (!Array.isArray(tunnels)) return document;
      return {
        ...document,
        tunnels: tunnels.map((tunnel: unknown) => {
          if (!isRecord(tunnel) || !('probe' in tunnel)) return tunnel;
          const { probe: _removed, ...rest } = tunnel;
          return rest;
        }),
      };
    },
  },
  {
    from: 8,
    name: 'a subscription is a group, and the egress is one id instead of a list',
    /**
     * Each subscription becomes a group whose members are the tunnels derived from it; the failover list
     * becomes one id.
     *
     * Why (2026-10-14, the owner's decision): on the bench board the feed had withdrawn the node `france`
     * was built from and offered others, and the device went on failing over to the dead one because the
     * list named it. A group's members are what the feed offers; nothing has to be kept in step by hand.
     *
     * What it does, in order, each a literal translation:
     *
     * 1. `subscriptions[i]` → `groups[i]` with the same id, name, enabled, url, refreshHours, lastRefresh.
     * 2. Every tunnel whose `derivedFrom.subscription` names it — **enabled or not**, since a group has no
     *    disabled members — leaves `tunnels` and becomes a member **with the same id**, so the outbound
     *    tags, unit names and the port order the device runs on do not move. Only VLESS is ever derived;
     *    anything else keeps its place as a tunnel.
     * 3. If one of those tunnels carried `resources`, the group takes them with its `dns` and
     *    `onUnavailable`: a feed whose node was used for named destinations is a group used for them.
     * 4. `policy.egress` is the first usable entry of the old order — `priority` minus `excluded`, then any
     *    other enabled `alternative`, as the old selector did — translated to its group when it was a
     *    derived tunnel. `priority` and `excluded` are removed.
     * 5. Rule targets and OpenVPN `via` that named a derived tunnel name its group instead.
     * 6. `role` and `derivedFrom` are removed from the tunnels that remain. An `alternative` keeps no
     *    `resources`: under schema 9 having resources is what makes a tunnel a resource, and an
     *    alternative's were never used.
     * 7. A member whose id is also a group's id is renamed `<group>-<n>`, the first unused. Every id is
     *    an outbound tag, and a group's tag is its selector. Found by a dry run against the bench
     *    board's profile, 2026-10-14: the subscription `claude` had derived a tunnel named `claude`.
     *    The member is renamed rather than the group because nothing names a member, while a rule, a
     *    `via` or the egress may name the group.
     */
    migrate(document) {
      const tunnels = (Array.isArray(document['tunnels']) ? document['tunnels'] : []).filter(isRecord);
      const subscriptions = (Array.isArray(document['subscriptions']) ? document['subscriptions'] : []).filter(isRecord);
      const policy = isRecord(document['policy']) ? document['policy'] : {};

      const groupOf = new Map<string, string>();
      const groups = subscriptions.map((subscription) => {
        const id = String(subscription['id']);
        const derived = tunnels.filter((tunnel) => {
          const from = tunnel['derivedFrom'];
          return isRecord(from) && from['subscription'] === id && tunnel['protocol'] === 'vless';
        });
        for (const tunnel of derived) groupOf.set(String(tunnel['id']), id);
        const carrier = derived.find((tunnel) => isRecord(tunnel['resources']));
        const { lastRefresh } = subscription;
        return {
          id,
          name: subscription['name'],
          enabled: subscription['enabled'] ?? true,
          url: subscription['url'],
          refreshHours: subscription['refreshHours'] ?? 24,
          ...(carrier !== undefined ? { resources: carrier['resources'] } : {}),
          ...(carrier !== undefined && carrier['dns'] !== undefined ? { dns: carrier['dns'] } : {}),
          onUnavailable: carrier?.['onUnavailable'] ?? 'block',
          members: derived.map((tunnel) => ({
            id: tunnel['id'],
            name: tunnel['name'],
            node: (tunnel['derivedFrom'] as Record<string, unknown>)['node'],
            protocol: 'vless',
            config: tunnel['config'],
          })),
          ...(lastRefresh !== undefined ? { lastRefresh } : {}),
        };
      });

      const groupIds = new Set(groups.map((group) => group.id));
      const used = new Set<string>([
        ...groupIds,
        ...tunnels.map((tunnel) => String(tunnel['id'])),
      ]);
      for (const group of groups) {
        for (const member of group.members) {
          if (!groupIds.has(String(member.id))) continue;
          let n = 1;
          while (used.has(`${group.id}-${String(n)}`)) n += 1;
          const fresh = `${group.id}-${String(n)}`;
          member.id = fresh;
          used.add(fresh);
        }
      }

      const renamed = (id: unknown): unknown => (typeof id === 'string' ? groupOf.get(id) ?? id : id);
      const byId = new Map(tunnels.map((tunnel) => [String(tunnel['id']), tunnel]));
      const excluded = new Set((Array.isArray(policy['excluded']) ? policy['excluded'] : []).map(String));
      const usable = (id: string): boolean => {
        const tunnel = byId.get(id);
        return tunnel !== undefined && tunnel['enabled'] !== false && tunnel['role'] === 'alternative' && !excluded.has(id);
      };
      const order = [
        ...(Array.isArray(policy['priority']) ? policy['priority'] : []).map(String),
        ...tunnels.map((tunnel) => String(tunnel['id'])),
      ];
      const first = order.find(usable);
      const { priority: _priority, excluded: _excluded, ...keptPolicy } = policy;

      const remaining = tunnels
        .filter((tunnel) => !groupOf.has(String(tunnel['id'])))
        .map((tunnel) => {
          const { role, derivedFrom: _derivedFrom, ...rest } = tunnel;
          if (role === 'alternative') delete rest['resources'];
          const config = rest['config'];
          if (isRecord(config) && typeof config['via'] === 'string') rest['config'] = { ...config, via: renamed(config['via']) };
          return rest;
        });

      const routing = isRecord(document['routing']) ? document['routing'] : {};
      const rules = (Array.isArray(routing['rules']) ? routing['rules'] : []).map((rule: unknown) => {
        if (!isRecord(rule) || !isRecord(rule['action'])) return rule;
        return { ...rule, action: { ...rule['action'], outbound: renamed(rule['action']['outbound']) } };
      });

      const { subscriptions: _subscriptions, ...rest } = document;
      return {
        ...rest,
        tunnels: remaining,
        groups,
        policy: { ...(first !== undefined ? { egress: renamed(first) } : {}), ...keptPolicy },
        routing: { ...routing, rules },
      };
    },
  },
];

export class ProfileVersionError extends Error {
  readonly found: unknown;
  readonly supported: number;

  constructor(message: string, found: unknown, supported: number) {
    super(message);
    this.name = 'ProfileVersionError';
    this.found = found;
    this.supported = supported;
  }
}

export interface MigrationResult {
  document: Record<string, unknown>;
  from: number;
  to: number;
  /** Which steps ran, for the import report — a silent migration is one nobody can audit. */
  applied: string[];
}

/**
 * Brings a document up to the current version.
 *
 * **All or nothing, and the caller's document is never touched.** Every step runs against a
 * `structuredClone` of the input and the result is returned only after the last one succeeds, so a
 * step that throws — version 6 → 7 refuses untranslatable tunnels by name — leaves the caller
 * holding exactly what it had. There is no half-migrated document to find later and no state to
 * clean up, which matters because a document is simultaneously the stored form, the API payload and
 * the export format: a partial result would have been indistinguishable from a real profile.
 *
 * A document from the **future** is refused rather than accepted on the assumption that unknown
 * fields are harmless. They are not: a profile written by a newer build may express something this
 * build would silently drop — a routing rule kind it does not know, a firewall field it ignores —
 * and dropping a routing rule is how traffic ends up somewhere nobody intended. Refusing names the
 * versions so the operator can see which side needs updating.
 */
export function migrateProfile(input: unknown): MigrationResult {
  if (!isRecord(input)) {
    throw new ProfileVersionError('a profile must be a JSON object', input, PROFILE_SCHEMA_VERSION);
  }

  const raw = input['schemaVersion'];
  const from = typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
  if (from === null || from < 1) {
    throw new ProfileVersionError(
      'this document has no usable schemaVersion, so it cannot be migrated safely',
      raw,
      PROFILE_SCHEMA_VERSION,
    );
  }
  if (from > PROFILE_SCHEMA_VERSION) {
    throw new ProfileVersionError(
      `this profile was written by a newer version (schemaVersion ${from}); this build understands ` +
        `up to ${PROFILE_SCHEMA_VERSION}. Update the device before importing it, rather than ` +
        'importing it with the parts this build does not understand silently removed.',
      from,
      PROFILE_SCHEMA_VERSION,
    );
  }

  let document: Record<string, unknown> = structuredClone(input);
  const applied: string[] = [];

  for (let version = from; version < PROFILE_SCHEMA_VERSION; version += 1) {
    const step = PROFILE_MIGRATIONS.find((candidate) => candidate.from === version);
    if (!step) {
      throw new ProfileVersionError(
        `no migration exists from schemaVersion ${version} to ${version + 1}`,
        version,
        PROFILE_SCHEMA_VERSION,
      );
    }
    document = step.migrate(document);
    document['schemaVersion'] = version + 1;
    applied.push(step.name);
  }

  return { document, from, to: PROFILE_SCHEMA_VERSION, applied };
}
