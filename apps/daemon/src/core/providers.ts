/**
 * One question about this device: **which catalogue entries can it run, and what is missing?**
 *
 * That is all this file has left. It used to be the provider registry — five providers, four
 * schemas of its own, a five-way switch on a provider name, and an escape hatch. The emission it
 * performed is now the catalogue's (`core/emit.ts`), the schemas it carried are now typed
 * configurations in `@wayfarer/schemas`, and the escape hatch is **deleted rather than hidden**.
 *
 * What survives is availability, and it survives because availability is genuinely **discovered**
 * and cannot be a table: whether this device can run VLESS depends on what the installed core was
 * built with and on which binaries are present, and both are read at runtime. That is the one thing
 * the old design got right, and it is kept — narrowed to exactly the question "this core was built
 * without QUIC", asked of each catalogue entry rather than of a registry that could be extended.
 *
 * There is deliberately no `schemaFor` any more. A schema per provider existed so a generic
 * renderer could draw a form for a protocol nobody here had heard of; each catalogue entry has a
 * designed screen instead, and a device without a core can now still have its profile written down.
 * Measured consequence of the old arrangement: a profile could not be **saved** on a device with no
 * core, because the secret pointers were derived from that schema at runtime.
 *
 * The name of this file is now wider than what is in it. It is kept because three modules outside
 * this task's territory import `buildRegistry` from this path.
 */

import { unionTypes, type JsonSchemaNode } from '@wayfarer/protocols';
import { CATALOGUE_LIST, type CoreCapabilities, type EntryAvailability } from './catalogue/index.ts';

/**
 * What the installed core turned out to be able to do.
 *
 * `known: false` means nothing was discovered — no core installed, the binary not yet unpacked, the
 * fetch unfinished. Every entry must then behave as though everything is offered: absence of
 * knowledge is not a negative answer, and treating it as one is how a missing binary blocks
 * configuration that has nothing to do with it.
 */
export function coreCapabilitiesOf(coreSchema: JsonSchemaNode | null): CoreCapabilities {
  if (coreSchema === null) return { known: false, outboundTypes: new Set() };
  const defs = (coreSchema['$defs'] ?? {}) as Record<string, JsonSchemaNode>;
  const outbound = defs['Outbound'] ?? null;
  return {
    known: true,
    outboundTypes: new Set(outbound === null ? [] : unionTypes(outbound)),
  };
}

/** One catalogue entry, as this device reports it. */
export interface CatalogueAvailability {
  /** The protocol key a profile stores. */
  id: string;
  /** What the owner holds, in his words. */
  title: string;
  availability: EntryAvailability;
}

/**
 * Every catalogue entry and whether this device can run it.
 *
 * Deliberately **not** extensible. The old registry took a list of inputs and would report whatever
 * it was handed, which is what made "a protocol nobody designed a screen for" expressible at all.
 * This walks `CATALOGUE_LIST`, so the answer is the catalogue and there is no way to add to it from
 * outside — adding an entry is a change to the catalogue and its screen, together.
 */
export interface Registry {
  list(): CatalogueAvailability[];
  get(id: string): CatalogueAvailability | null;
}

export interface BuildRegistryInput {
  /** The schema the installed core emitted, parsed. Null when nothing is known about the core. */
  coreSchema: JsonSchemaNode | null;
  /** Which binaries are present, for saying what is missing rather than guessing. */
  present: Set<string>;
}

export function buildRegistry(input: BuildRegistryInput): Registry {
  const core = coreCapabilitiesOf(input.coreSchema);
  const entries = CATALOGUE_LIST.map((entry) => ({
    id: entry.id as string,
    title: entry.title,
    availability: entry.availability({ core, installed: input.present }),
  }));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  return {
    list: () => [...entries],
    get: (id) => byId.get(id) ?? null,
  };
}
